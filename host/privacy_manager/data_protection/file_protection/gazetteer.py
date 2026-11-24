"""Offline first-name gazetteer for PERSON precision.

A compact, curated set of common given names across several language
families. It is NOT exhaustive — it doesn't need to be. Its only job is
to give the file detector a positive signal that raises PERSON precision
above the weak "two capitalized tokens" regex, which otherwise flags any
``Title Case Pair`` (product names, place names, department labels).

Design:
* Lowercased for case-insensitive membership tests.
* Kept in-module (no data file to ship / resolve at runtime); tens of KB
  of strings, negligible import cost.
* Model-free — this is the middle ground between the bare regex and
  pulling spaCy / an NER model into the file pipeline.

Usage: :func:`has_known_first_name` returns True if the first whitespace
token of a candidate value is a known given name. The detector treats
that as corroboration, not proof (surnames + rare names still pass via
the regex; the gazetteer only *boosts* confidence).
"""

from __future__ import annotations

# A pragmatic core set: the most common given names in English plus
# high-frequency names from Spanish, German, French, Italian, Nordic,
# Slavic, Arabic, Indian, and East-Asian romanizations. Extend freely —
# membership is O(1) so size barely matters.
_FIRST_NAMES: frozenset[str] = frozenset(
    name.lower()
    for name in (
        # English (M)
        "James", "John", "Robert", "Michael", "William", "David", "Richard",
        "Joseph", "Thomas", "Charles", "Christopher", "Daniel", "Matthew",
        "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Joshua",
        "Kenneth", "Kevin", "Brian", "George", "Edward", "Ronald", "Timothy",
        "Jason", "Jeffrey", "Ryan", "Jacob", "Gary", "Nicholas", "Eric",
        "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon",
        "Benjamin", "Samuel", "Gregory", "Alexander", "Patrick", "Jack",
        "Dennis", "Jerry", "Tyler", "Aaron", "Henry", "Nathan", "Peter",
        "Adam", "Sean", "Ethan", "Zachary", "Noah", "Liam", "Mason",
        # English (F)
        "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara",
        "Susan", "Jessica", "Sarah", "Karen", "Nancy", "Lisa", "Margaret",
        "Betty", "Sandra", "Ashley", "Dorothy", "Kimberly", "Emily",
        "Donna", "Michelle", "Carol", "Amanda", "Melissa", "Deborah",
        "Stephanie", "Rebecca", "Laura", "Sharon", "Cynthia", "Kathleen",
        "Amy", "Angela", "Anna", "Ruth", "Brenda", "Pamela", "Nicole",
        "Katherine", "Samantha", "Christine", "Emma", "Catherine", "Olivia",
        "Sophia", "Ava", "Isabella", "Mia", "Charlotte", "Grace", "Chloe",
        # Spanish / Portuguese
        "Juan", "Carlos", "José", "Jose", "Luis", "Miguel", "Jorge",
        "Francisco", "Antonio", "Manuel", "Pedro", "Diego", "Rafael",
        "Maria", "María", "Carmen", "Ana", "Isabel", "Lucia", "Lucía",
        "Sofia", "Sofía", "Elena", "Rosa", "Marta", "Cruz",
        # German
        "Hans", "Klaus", "Jürgen", "Jurgen", "Günter", "Gunter", "Wolfgang",
        "Dieter", "Karl", "Heinz", "Stefan", "Andreas", "Thomas", "Frank",
        "Ursula", "Helga", "Ingrid", "Renate", "Monika", "Petra", "Sabine",
        # French
        "Pierre", "Jean", "Michel", "Alain", "Philippe", "Nicolas", "Luc",
        "Claude", "Jacques", "Louis", "Marc", "Sylvie", "Nathalie",
        "Isabelle", "Catherine", "Françoise", "Francoise", "Céline", "Celine",
        # Italian
        "Giuseppe", "Giovanni", "Marco", "Luca", "Francesco", "Alessandro",
        "Andrea", "Matteo", "Lorenzo", "Giulia", "Francesca", "Chiara",
        "Valentina", "Federica",
        # Nordic
        "Lars", "Erik", "Sven", "Nils", "Bjørn", "Bjorn", "Anders", "Magnus",
        "Astrid", "Ingrid", "Freya", "Sigrid",
        # Slavic
        "Ivan", "Dmitri", "Sergei", "Vladimir", "Alexei", "Nikolai",
        "Olga", "Natasha", "Svetlana", "Tatiana", "Katarzyna", "Piotr",
        # Arabic
        "Mohammed", "Muhammad", "Ahmed", "Ali", "Omar", "Hassan", "Ibrahim",
        "Yusuf", "Khalid", "Fatima", "Aisha", "Layla", "Zainab", "Noor",
        # Indian
        "Raj", "Rahul", "Amit", "Vijay", "Sanjay", "Arjun", "Ravi", "Anil",
        "Priya", "Anjali", "Deepa", "Kavita", "Sunita", "Neha", "Pooja",
        # East Asian romanizations
        "Wei", "Li", "Ming", "Chen", "Jun", "Yong", "Hui", "Lei",
        "Hiroshi", "Takeshi", "Yuki", "Kenji", "Akira", "Haruki",
        "Min", "Jin", "Soo", "Hyun", "Ji", "Young",
    )
)


def has_known_first_name(value: str) -> bool:
    """Return True if the first token of ``value`` is a known given name."""
    value = value.strip()
    if not value:
        return False
    first = value.split()[0].strip(".,")
    return first.lower() in _FIRST_NAMES
