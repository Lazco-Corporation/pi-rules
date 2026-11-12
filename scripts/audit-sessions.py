"""Measure how pi-rules behaved in local pi sessions.

Usage:
  python3 scripts/audit-sessions.py [--since YYYY-MM-DD] [--sessions DIR] [--rules DIR]

The script reads the pi session files and the user rules, and prints JSON totals:
missing rules on the active branch, duplicate injections, paused tool calls and
their retries, and matching files that no rule reached.
"""
import argparse
import json
import os
import re
from collections import Counter, defaultdict

ARGS_PARSER = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ARGS_PARSER.add_argument("--since", help="only sessions that started on or after this date (YYYY-MM-DD)")
ARGS_PARSER.add_argument("--sessions", default=os.path.expanduser("~/.pi/agent/sessions"), help="pi session directory")
ARGS_PARSER.add_argument("--rules", default=os.path.expanduser("~/.agents/rules"), help="user rule directory to match against")
ARGS = ARGS_PARSER.parse_args()

SESSIONS_DIR = ARGS.sessions
RULES_DIR = ARGS.rules
HOME = os.path.expanduser("~")
BLOCK_PREFIX = "[pi-rules] Tool `"
GOVERNED_TOOLS = {"read", "edit", "write"}


def glob_to_regex(pattern):
    pattern = pattern.lstrip("./")
    out = ""
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if pattern.startswith("**/", index):
            out += "(?:.*/)?"
            index += 3
            continue
        if pattern.startswith("**", index):
            out += ".*"
            index += 2
            continue
        if char == "*":
            out += "[^/]*"
        elif char == "?":
            out += "[^/]"
        else:
            out += re.escape(char)
        index += 1
    return re.compile("^" + out + "$")


def load_rules():
    rules = {}
    for name in sorted(os.listdir(RULES_DIR)):
        if not name.endswith(".md"):
            continue
        text = open(os.path.join(RULES_DIR, name)).read()
        patterns = []
        if text.startswith("---\n"):
            front = text[4 : text.index("\n---", 4)]
            patterns = [m.strip().strip('"') for m in re.findall(r"^\s*-\s*(.+)$", front, re.M)]
        rules[name] = {"patterns": patterns, "regexes": [glob_to_regex(p) for p in patterns], "size": len(text.encode())}
    return rules


RULES = load_rules()
SCOPED = {name: rule for name, rule in RULES.items() if rule["patterns"]}
UNCONDITIONAL = [name for name, rule in RULES.items() if not rule["patterns"]]


def scoped_rules_for_abs(abs_path):
    """Rules whose glob matches the absolute path (ignoring cwd), i.e. the user's intent."""
    matched = []
    relative_home = os.path.relpath(abs_path, "/")
    for name, rule in SCOPED.items():
        for pattern, regex in zip(rule["patterns"], rule["regexes"]):
            candidate = relative_home if pattern.startswith("/") else abs_path.lstrip("/")
            if regex.match(candidate):
                matched.append(name)
                break
    return matched


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


BASH_FILE_TOKEN = re.compile(r"(?:^|[\s'\"=<>|;&(])((?:~|/|\.{1,2}/)?[\w./@+-]*(?:\.(?:sh|go|swift|ts|js|zshrc|bashrc|zprofile|zshenv|bash_profile|yml|yaml|json)|Dockerfile[\w.-]*|go\.mod|go\.sum))(?=$|[\s'\";|&)<>])")
BASH_WRITE = re.compile(r"\bsed\s+-i|\bperl\s+-p?i|\btee\b|(?<![0-9&])>\s*[^&\s]|\bcat\s*<<|\bmv\b|\bcp\b|\bpatch\b|\bgit\s+apply")


def analyze(path, totals, samples):
    entries = {}
    order = []
    session_cwd = None
    for line in open(path, encoding="utf-8", errors="replace"):
        if '"type":"session"' in line[:40]:
            header = json.loads(line)
            if ARGS.since and header.get("timestamp", "") < ARGS.since:
                return
            session_cwd = header.get("cwd")
            continue
        if not any(key in line[:120] for key in ('"type":"message"', '"type":"custom_message"', '"type":"compaction"', '"type":"branch_summary"')):
            continue
        entry = json.loads(line)
        entries[entry["id"]] = entry
        order.append(entry["id"])
    if not order or not session_cwd:
        return
    totals["sessions"] += 1

    # Active branch = chain from the last entry back to the root.
    active = []
    cursor = order[-1]
    while cursor in entries:
        active.append(cursor)
        cursor = entries[cursor].get("parentId")
    active.reverse()
    active_set = set(active)
    if len(active_set) < len(order):
        totals["sessions_with_branches"] += 1

    tool_calls = {}
    injected_labels_active = Counter()
    unconditional_present = False
    blocked_calls = []
    compactions = 0
    for entry_id in order:
        entry = entries[entry_id]
        if entry["type"] == "custom_message" and entry.get("customType") == "pi-rules-injection":
            labels = (entry.get("details") or {}).get("sources") or re.findall(r"^## Rule: (.+)$", entry.get("content", ""), re.M)
            totals["injection_messages"] += 1
            totals["injection_bytes"] += len(entry.get("content", "").encode())
            if entry_id in active_set:
                for label in labels:
                    injected_labels_active[label] += 1
                if any(label.endswith("/" + name) for label in labels for name in UNCONDITIONAL):
                    unconditional_present = True
        elif entry["type"] == "compaction":
            compactions += 1
        elif entry["type"] == "message":
            message = entry["message"]
            if message.get("role") == "assistant":
                calls = [part for part in message.get("content", []) if isinstance(part, dict) and part.get("type") == "toolCall"]
                for call in calls:
                    tool_calls[call.get("id")] = {"name": call.get("name"), "args": call.get("arguments") or {}, "batch": len(calls), "entry": entry_id}
                    analyze_call(call, session_cwd, totals, samples, path)
            elif message.get("role") == "toolResult":
                text = text_of(message.get("content"))
                if text.startswith(BLOCK_PREFIX):
                    blocked_calls.append(message.get("toolCallId"))

    # Blocks: retry behavior.
    for call_id in blocked_calls:
        call = tool_calls.get(call_id)
        if not call:
            continue
        totals["blocks"] += 1
        totals["blocks_by_tool"][call["name"]] += 1
        target = call["args"].get("path")
        later = [c for c in tool_calls.values() if c["name"] == call["name"] and c["args"].get("path") == target and c is not call]
        retry = next((c for c in later if order.index(c["entry"]) > order.index(call["entry"])), None)
        if retry is None:
            totals["blocks_no_retry"] += 1
        elif retry["args"] == call["args"]:
            totals["blocks_identical_retry"] += 1
        else:
            totals["blocks_changed_retry"] += 1
        if call["batch"] > 1:
            totals["blocks_in_parallel_batch"] += 1

    # Duplicate injections on the active branch without compaction.
    if compactions == 0:
        dupes = {label: count for label, count in injected_labels_active.items() if count > 1}
        if dupes:
            totals["sessions_with_duplicate_injection"] += 1
            for label, count in dupes.items():
                totals["duplicate_rule_injections"][label] += count - 1
            if len(samples["duplicate"]) < 5:
                samples["duplicate"].append((path, dupes))

    # Active branch lost the unconditional rules while another branch had them.
    if injected_labels_active and not unconditional_present:
        totals["active_branch_missing_unconditional"] += 1
    if not injected_labels_active and totals_has_any_injection(entries):
        totals["active_branch_missing_all_rules"] += 1
        if len(samples["lost"]) < 5:
            samples["lost"].append(path)


def totals_has_any_injection(entries):
    return any(e["type"] == "custom_message" and e.get("customType") == "pi-rules-injection" for e in entries.values())


def analyze_call(call, cwd, totals, samples, session_path):
    name = call.get("name")
    args = call.get("arguments") or {}
    totals["tool_calls"][name] += 1
    raw_path = args.get("path") if isinstance(args.get("path"), str) else None
    if raw_path:
        abs_path = os.path.normpath(os.path.join(cwd, os.path.expanduser(raw_path.lstrip("@"))))
        matched = scoped_rules_for_abs(abs_path)
        if not matched:
            return
        inside = abs_path.startswith(cwd.rstrip("/") + "/")
        if name in GOVERNED_TOOLS:
            key = "governed_match_inside" if inside else "governed_match_outside_cwd"
            totals[key] += 1
            if not inside:
                for rule in matched:
                    totals["missed_outside_cwd_by_rule"][rule] += 1
                if len(samples["outside"]) < 8:
                    samples["outside"].append((name, raw_path, cwd))
            elif any(SCOPED[r]["patterns"][0].startswith("/") for r in matched):
                totals["absolute_pattern_inside_cwd"] += 1
        else:
            totals["ungoverned_tool_match"][name] += 1
        return
    if name == "bash" and isinstance(args.get("command"), str):
        command = args["command"]
        for token in BASH_FILE_TOKEN.findall(command):
            abs_path = os.path.normpath(os.path.join(cwd, os.path.expanduser(token)))
            matched = scoped_rules_for_abs(abs_path)
            if not matched:
                continue
            writes = bool(BASH_WRITE.search(command))
            totals["bash_match_write" if writes else "bash_match_readonly"] += 1
            for rule in matched:
                totals["bash_match_by_rule"][rule] += 1
            if writes and len(samples["bash_write"]) < 8:
                samples["bash_write"].append(command[:160])
            break


def main():
    totals = defaultdict(int)
    for key in ("blocks_by_tool", "tool_calls", "duplicate_rule_injections", "missed_outside_cwd_by_rule", "ungoverned_tool_match", "bash_match_by_rule"):
        totals[key] = Counter()
    samples = defaultdict(list)
    files = []
    for root, _dirs, names in os.walk(SESSIONS_DIR):
        files += [os.path.join(root, n) for n in names if n.endswith(".jsonl")]
    for index, path in enumerate(sorted(files)):
        try:
            analyze(path, totals, samples)
        except Exception as error:  # noqa: BLE001
            totals["errors"] += 1
            if len(samples["errors"]) < 3:
                samples["errors"].append((path, repr(error)))
    totals["tool_calls"] = Counter(dict(totals["tool_calls"].most_common(25)))
    print(json.dumps({"rules": {k: {"patterns": v["patterns"], "size": v["size"]} for k, v in RULES.items()}, "totals": totals, "samples": samples}, ensure_ascii=False, indent=1, default=str))


main()
