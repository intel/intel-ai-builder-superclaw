"""Offline COUNTRY + CITY gazetteer for model-free geo-entity masking.

Without a gazetteer the model-free tier catches almost no CITY/COUNTRY:
famous, finite place names (``Berlin``, ``Lyon``, ``Lima``) match neither
the regex patterns nor the English NER. Countries and major cities are
closed, enumerable sets, which is exactly the case a gazetteer solves at
high precision.

Design (mirrors :mod:`file_protection.gazetteer` for first names):
* Curated, in-module (no data file to ship / resolve at runtime).
* **Country** membership is near-zero precision risk: ISO 3166 short names +
  common variants form an unambiguous closed set.
* **City** membership is riskier — some city names are also common words or
  surnames (``Nice``, ``Reading``, ``Lima``, ``Mobile``). We keep a curated
  high-frequency set and gate matches on proper-noun *capitalization* at the
  call site so a lowercase ``nice`` in prose is never masked.
* Lookups are case-insensitive membership on a normalized key; matching in
  prose is done by the span layer with word boundaries + capitalization.

License note: this is a hand-curated list (like the first-name gazetteer),
NOT derived from GeoNames (CC-BY) or any share-alike source, so it stays
within the MIT/Apache-only bar the rest of the project honors.
"""

from __future__ import annotations

import re


def _norm(s: str) -> str:
    """Normalize a place name for membership: strip, collapse spaces, lower."""
    return re.sub(r"\s+", " ", s.strip()).lower()


# --------------------------------------------------------------------------
# Countries — ISO 3166 short names plus the handful of common variants that
# appear in real prose. Closed set; masking any of these is safe.
# --------------------------------------------------------------------------
_COUNTRY_NAMES: tuple[str, ...] = (
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina",
    "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain",
    "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin",
    "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil",
    "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cambodia", "Cameroon",
    "Canada", "Cape Verde", "Chad", "Chile", "China", "Colombia", "Comoros",
    "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia",
    "Czech Republic", "Denmark", "Djibouti", "Dominica", "Dominican Republic",
    "Ecuador", "Egypt", "El Salvador", "Estonia", "Eswatini", "Ethiopia",
    "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany",
    "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guyana", "Haiti",
    "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq",
    "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan",
    "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon",
    "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
    "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta",
    "Mauritania", "Mauritius", "Mexico", "Moldova", "Monaco", "Mongolia",
    "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru",
    "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria",
    "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau",
    "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru",
    "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia",
    "Rwanda", "Samoa", "San Marino", "Saudi Arabia", "Senegal", "Serbia",
    "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia",
    "Somalia", "South Africa", "South Korea", "South Sudan", "Spain",
    "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
    "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Togo", "Tonga",
    "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
    "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom",
    "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City",
    "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe",
    # Common variants / short forms seen in prose.
    "UK", "USA", "UAE", "US", "U.S.", "U.S.A.", "U.K.",
    "Great Britain", "Britain", "America", "Holland", "Korea", "Russia",
    "Ivory Coast", "Cote d'Ivoire",
)

COUNTRIES: frozenset[str] = frozenset(_norm(c) for c in _COUNTRY_NAMES)

# Multi-word countries need phrase matching; the longest first so
# "United States" wins over a bare "United". Sorted by token length desc.
COUNTRY_PHRASES: tuple[str, ...] = tuple(
    sorted({c for c in _COUNTRY_NAMES}, key=lambda s: -len(s))
)


# --------------------------------------------------------------------------
# Cities — curated high-frequency world cities (capitals + major metros).
# Not exhaustive; covers the names that actually recur in business/finance
# documents. Ambiguous-with-common-word names are handled by capitalization
# gating at the call site, not by exclusion here.
# --------------------------------------------------------------------------
_CITY_NAMES: tuple[str, ...] = (
    # Europe
    "London", "Paris", "Berlin", "Madrid", "Barcelona", "Rome", "Milan",
    "Naples", "Turin", "Amsterdam", "Rotterdam", "Brussels", "Antwerp",
    "Vienna", "Zurich", "Geneva", "Bern", "Munich", "Frankfurt", "Hamburg",
    "Cologne", "Stuttgart", "Dusseldorf", "Lyon", "Marseille", "Nice",
    "Toulouse", "Bordeaux", "Lisbon", "Porto", "Dublin", "Edinburgh",
    "Glasgow", "Manchester", "Birmingham", "Liverpool", "Leeds", "Copenhagen",
    "Stockholm", "Gothenburg", "Oslo", "Helsinki", "Warsaw", "Krakow",
    "Prague", "Budapest", "Bucharest", "Sofia", "Athens", "Thessaloniki",
    "Belgrade", "Zagreb", "Ljubljana", "Bratislava", "Vilnius", "Riga",
    "Tallinn", "Reykjavik", "Luxembourg", "Monaco", "Moscow",
    "Saint Petersburg", "Kyiv", "Kiev", "Minsk", "Istanbul", "Ankara",
    # Americas
    "New York", "Los Angeles", "Chicago", "Houston", "Phoenix",
    "Philadelphia", "San Antonio", "San Diego", "Dallas", "San Jose",
    "Austin", "San Francisco", "Seattle", "Denver", "Boston", "Miami",
    "Atlanta", "Washington", "Detroit", "Minneapolis", "Portland",
    "Las Vegas", "Baltimore", "Toronto", "Montreal", "Vancouver", "Calgary",
    "Ottawa", "Mexico City", "Guadalajara", "Monterrey", "Bogota",
    "Medellin", "Lima", "Santiago", "Buenos Aires", "Cordoba", "Sao Paulo",
    "Rio de Janeiro", "Brasilia", "Salvador", "Caracas", "Quito",
    "Montevideo", "Asuncion", "La Paz",
    # Asia / Middle East
    "Tokyo", "Osaka", "Kyoto", "Yokohama", "Nagoya", "Seoul", "Busan",
    "Beijing", "Shanghai", "Shenzhen", "Guangzhou", "Chengdu", "Hong Kong",
    "Taipei", "Singapore", "Bangkok", "Jakarta", "Surabaya", "Manila",
    "Kuala Lumpur", "Hanoi", "Ho Chi Minh City", "Mumbai", "Delhi",
    "New Delhi", "Bangalore", "Bengaluru", "Hyderabad", "Chennai", "Kolkata",
    "Pune", "Ahmedabad", "Karachi", "Lahore", "Islamabad", "Dhaka", "Dubai",
    "Abu Dhabi", "Doha", "Riyadh", "Jeddah", "Kuwait City", "Tehran",
    "Baghdad", "Amman", "Beirut", "Jerusalem", "Tel Aviv",
    # Africa / Oceania
    "Cairo", "Alexandria", "Lagos", "Abuja", "Nairobi", "Accra",
    "Johannesburg", "Cape Town", "Durban", "Pretoria", "Casablanca",
    "Rabat", "Tunis", "Algiers", "Addis Ababa", "Dar es Salaam", "Sydney",
    "Melbourne", "Brisbane", "Perth", "Adelaide", "Auckland", "Wellington",
)

CITIES: frozenset[str] = frozenset(_norm(c) for c in _CITY_NAMES)

CITY_PHRASES: tuple[str, ...] = tuple(
    sorted({c for c in _CITY_NAMES}, key=lambda s: -len(s))
)


def is_country(value: str) -> bool:
    """True if ``value`` is a known country name (case-insensitive)."""
    return _norm(value) in COUNTRIES


def is_city(value: str) -> bool:
    """True if ``value`` is a known city name (case-insensitive)."""
    return _norm(value) in CITIES
