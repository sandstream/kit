"""Unicode in a skill's frontmatter `name`, judged for skill_scan.py and plugin_scan.py.

The agentskills.io spec allows Unicode lowercase letters and digits in a skill `name` (kit#1082),
and any harness that loads a SKILL.md lists and picks the skill by that name: Claude Code, OpenAI
Codex and every other reader of the format. A name such as `p\u0430yments`, whose second letter
is CYRILLIC SMALL LETTER A, then reads as `payments` to a person choosing between skills. Each
rule here is a warning, never a fail: a non-ASCII name is allowed, it is only worth a look.

Deterministic and stdlib only (ADR-0001, ADR-0002): no model, no confusables download. The table
is a short hand-picked subset of Unicode's confusables.txt (UTS #39): lowercase Cyrillic and
Greek letters that render like one ASCII lowercase letter in common fonts. It is deliberately
small; a lookalike missing from it still gets the plain non-ASCII warning.
"""

import re
import unicodedata

CONFUSABLES = {
    # Cyrillic
    "\u0430": "a",  # CYRILLIC SMALL LETTER A
    "\u0441": "c",  # CYRILLIC SMALL LETTER ES
    "\u0501": "d",  # CYRILLIC SMALL LETTER KOMI DE
    "\u0435": "e",  # CYRILLIC SMALL LETTER IE
    "\u04bb": "h",  # CYRILLIC SMALL LETTER SHHA
    "\u0456": "i",  # CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
    "\u0458": "j",  # CYRILLIC SMALL LETTER JE
    "\u04cf": "l",  # CYRILLIC SMALL LETTER PALOCHKA
    "\u043e": "o",  # CYRILLIC SMALL LETTER O
    "\u0440": "p",  # CYRILLIC SMALL LETTER ER
    "\u051b": "q",  # CYRILLIC SMALL LETTER QA
    "\u0455": "s",  # CYRILLIC SMALL LETTER DZE
    "\u0475": "v",  # CYRILLIC SMALL LETTER IZHITSA
    "\u051d": "w",  # CYRILLIC SMALL LETTER WE
    "\u0445": "x",  # CYRILLIC SMALL LETTER HA
    "\u0443": "y",  # CYRILLIC SMALL LETTER U
    # Greek
    "\u03b1": "a",  # GREEK SMALL LETTER ALPHA
    "\u03f2": "c",  # GREEK LUNATE SIGMA SYMBOL
    "\u03b9": "i",  # GREEK SMALL LETTER IOTA
    "\u03f3": "j",  # GREEK LETTER YOT
    "\u03ba": "k",  # GREEK SMALL LETTER KAPPA
    "\u03bf": "o",  # GREEK SMALL LETTER OMICRON
    "\u03c1": "p",  # GREEK SMALL LETTER RHO
    "\u03c5": "u",  # GREEK SMALL LETTER UPSILON
    "\u03bd": "v",  # GREEK SMALL LETTER NU
    "\u03c7": "x",  # GREEK SMALL LETTER CHI
    "\u03b3": "y",  # GREEK SMALL LETTER GAMMA
}


def frontmatter_name(text):
    """The value of the top-level `name:` key of the frontmatter, unquoted, or None."""
    lines = text.lstrip("\ufeff").replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        m = re.match(r"^name\s*:\s*(.*?)\s*$", line)
        if m:
            value = m.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value or None
    return None


def _code_points(chars):
    return ", ".join(f"U+{ord(ch):04X} {unicodedata.name(ch, 'UNNAMED')}" for ch in chars)


def skeleton(name):
    """The name after NFKC and the confusables table: what a reader is likely to see."""
    return "".join(CONFUSABLES.get(ch, ch) for ch in unicodedata.normalize("NFKC", name))


def name_warnings(name, folder):
    """Warnings for a skill `name` and the directory that holds its SKILL.md."""
    out = []
    odd = list(dict.fromkeys(ch for ch in name if ord(ch) > 0x7F))
    if odd:
        seen = skeleton(name)
        if seen.isascii() and seen != name:
            out.append(f"skill name {ascii(name)} looks like `{seen}`: {_code_points(odd)} -- Claude Code, Codex "
                       "and other SKILL.md readers list the skill by this name, so it can pass for another")
        else:
            out.append(f"skill name {ascii(name)} has characters outside ASCII: {_code_points(odd)}")
    nfkc = unicodedata.normalize("NFKC", name)
    if folder and folder != name and unicodedata.normalize("NFKC", folder) == nfkc:
        out.append(f"skill folder {ascii(folder)} and name {ascii(name)} differ only in Unicode normalisation "
                   "(NFKC) -- macOS stores file names in NFD, so a harness that compares them byte for "
                   "byte may not match the skill to its folder")
    return out


def judge(rep, label, text, folder):
    """Warn on the frontmatter `name` of one SKILL.md (`folder` is its directory's name). Names are
    printed escaped (`'p\\u0430yments'`): the literal would look exactly like the ASCII name, and
    a Windows console in a legacy code page cannot print it."""
    name = frontmatter_name(text)
    if name:
        for message in name_warnings(name, folder):
            rep.warn(f"{label}{message}")
