"""Dopasowanie nazw wypowiedzianych po polsku do produktów, leków i osób (odmiana: „mleka” → „Mleko”, „Zosi” → „Zosia”)."""

from __future__ import annotations

import re
import unicodedata


def key(text: str) -> str:
    """Małe litery, bez polskich znaków i interpunkcji."""
    text = unicodedata.normalize("NFD", str(text).lower().replace("ł", "l"))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def word_match(a: str, b: str) -> bool:
    """Ten sam wyraz w innej formie: wspólny początek, różnica tylko w końcówce."""
    if a == b:
        return True
    if min(len(a), len(b)) < 3:
        return False
    return _prefix(a, b) >= max(3, min(len(a), len(b)) - 2)


def score(query: str, name: str) -> float:
    """0..1 – jak dobrze nazwa pasuje do wypowiedzi."""
    q = [w for w in key(query).split() if len(w) >= 2]
    n = key(name).split()
    if not q or not n:
        return 0.0
    hits = sum(1 for w in q if any(word_match(w, x) for x in n))
    if not hits:
        return 0.0
    # Pełne dopasowanie wszystkich słów zapytania; premia za podobną długość nazwy.
    return hits / len(q) - 0.01 * abs(len(n) - len(q))


def best(query: str, rows: list[dict], field: str = "name", minimum: float = 0.5) -> list[dict]:
    """Najlepiej pasujące wiersze (najpierw dokładne nazwy i numery)."""
    q = key(query)
    exact = [r for r in rows if key(r.get(field, "")) == q or str(r.get("id")) == str(query).strip()]
    if exact:
        return exact
    scored = sorted(((score(query, r.get(field, "")), r) for r in rows), key=lambda x: -x[0])
    if not scored or scored[0][0] < minimum:
        return []
    top = scored[0][0]
    return [r for s, r in scored if s >= top - 1e-9]


def person(spoken: str, known: list[str]) -> str:
    """„Zosi” → „Zosia”, gdy taka osoba jest znana; w przeciwnym razie wypowiedziana forma z wielkiej litery."""
    s = key(spoken)
    for name in known:
        if key(name) == s or word_match(s, key(name)):
            return name
    return spoken.strip().capitalize()
