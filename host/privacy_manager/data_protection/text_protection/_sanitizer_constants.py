"""Static sanitizer patterns and category mappings.

This module keeps regex patterns, financial keywords, label mappings, and skip
lists out of ``sanitizer.py``. ``sanitizer.py`` re-binds these constants onto
``ConsistentSanitizer`` for compatibility with existing callers and tests.
"""

from __future__ import annotations

from typing import Dict, List, Set


TOKEN_PATTERNS: Dict[str, str] = {
    "CREDITCARDNUM": r"\b(?:4[0-9]{3}([ -]?[0-9]{4}){3}|5[1-5][0-9]{2}([ -]?[0-9]{4}){3}|3[47][0-9]{2}([ -]?[0-9]{6})([ -]?[0-9]{5})?|3(?:0[0-5]|[68][0-9])[0-9]([ -]?[0-9]{4}){3}|6(?:011|5[0-9]{2})([ -]?[0-9]{4}){3}|(?:2131|1800|35\d{2})([ -]?[0-9]{4}){3})\b",
    # IBAN: country code, check digits, and account text. Lookarounds avoid
    # matching inside a longer alphanumeric token; checksum is not validated.
    "IBAN": (
        r"(?<![A-Z0-9])"
        r"[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?"
        r"(?![A-Z0-9])"
    ),
    # SEX_VALUE: closed-list values after a literal "sex" label, e.g.
    # "sex: female". This regex backstop is more reliable than NER for forms.
    "SEX_VALUE": (
        r"(?<=\b[Ss]ex[:\s])\s*"
        r"(?-i:(?:female|male|F|M|f|m))"
        r"(?=[\s,.;:)]|$)"
    ),
    # GENDER_VALUE: closed-list values after a literal "gender" label. The
    # label guard prevents matching ordinary body-text words.
    "GENDER_VALUE": (
        r"(?<=\b[Gg]ender[:\s])\s*"
        r"(?-i:(?:woman|man|non-binary|nonbinary|genderqueer|"
        r"agender|bigender|genderfluid|two-spirit|other))"
        r"(?=[\s,.;:)]|$)"
    ),
    # COUNTRY: closed-list regex for sovereign country names.
    "COUNTRY_NAME": (
        r"\b(?-i:"
        r"United States|United Kingdom|United Arab Emirates|"
        r"Saudi Arabia|South Africa|South Korea|North Korea|"
        r"New Zealand|Hong Kong|Sri Lanka|Czech Republic|"
        r"Costa Rica|Dominican Republic|"
        r"USA|UK|UAE|"
        r"Canada|Mexico|Brazil|Argentina|Chile|Peru|Colombia|"
        r"France|Germany|Spain|Italy|Portugal|Netherlands|"
        r"Belgium|Switzerland|Austria|Sweden|Norway|Denmark|"
        r"Finland|Ireland|Greece|Poland|Russia|Ukraine|Turkey|"
        r"China|Japan|India|Pakistan|Indonesia|Singapore|"
        r"Thailand|Vietnam|Philippines|Malaysia|Bangladesh|"
        r"Israel|Egypt|Nigeria|Kenya|Morocco|Algeria|Ethiopia|"
        r"Australia|Iceland"
        r")\b"
    ),
    # COUNTY_NAME: administrative subdivisions such as "Orange County".
    # Captured group 1 is the full location span.
    "COUNTY_NAME": (
        r"\b((?-i:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+"
        r"(?-i:County|Borough|Parish|District|Province|Prefecture|"
        r"Canton|Region|Shire))\b"
    ),
    # ROLE_PERSON: names after role labels, such as "CFO Sarah Lee".
    # Captured group 1 is only the name; the role label is not redacted.
    "ROLE_PERSON": (
        r"\b(?-i:Consignee|Recipient|Beneficiary|Sender|Shipper|"
        r"Buyer|Seller|Plaintiff|Defendant|Witness|Suspect|"
        r"Petitioner|Respondent|Donor|Customer|Owner|Holder|"
        r"Patient|Member|Applicant|Sponsor|Vendor|Client|"
        r"Elector|Voter|Citizen|Resident|"
        # Financial / business / clinical / staffing roles.
        r"cardholder|Cardholder|taxpayer|Taxpayer|"
        r"caller|Caller|Caller's|"
        r"advisor|Advisor|adviser|Adviser|"
        r"provider|Provider|"
        r"author|Author|editor|Editor|reviewer|Reviewer|"
        r"CFO|CEO|CTO|COO|CIO|CMO|"
        r"manager|Manager|director|Director)"
        r"[:,]?\s+(?:(?-i:Dr|Mr|Mrs|Ms|Mx|Prof)\.?\s+)?"
        r"((?-i:[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2}))"
        r"(?=[\s,.;:()])"
    ),
    # ORG_GAZETTEER: known organizations that may not have a legal suffix.
    "ORG_GAZETTEER": (
        r"\b(?-i:"
        # Banks / financial institutions
        r"Wells Fargo|JPMorgan Chase|JPMorgan|Bank of America|"
        r"Citibank|Citigroup|Goldman Sachs|Morgan Stanley|"
        r"Deutsche Bank|Barclays|HSBC|UBS|Credit Suisse|"
        r"BNP Paribas|Santander|ING|"
        # Payment networks. "Visa" excludes immigration-document contexts.
        r"Visa(?!\s+(?:[BHFJLEKO]\d|[BHFJLEKO]-\d|"
        r"valid|expires|expired|expiring|issued|stamp|application))|"
        r"Mastercard|Master Card|American Express|Amex|"
        r"Discover|UnionPay|JCB|Diners Club|"
        # Tech brands
        r"Initech|Globex|Hooli|Pied Piper|"
        r"Microsoft|Google|Apple|Amazon|Meta|Facebook|"
        r"Netflix|Salesforce|Oracle|IBM|Intel|Nvidia|"
        # Universities
        r"Berkeley|Stanford|Harvard|MIT|Caltech|Princeton|Yale|"
        r"Oxford|Cambridge"
        r")\b"
    ),
    # ORG_NAME: organization names anchored by business/institution suffixes.
    "ORG_NAME": (
        r"(?:(?<!\w)"
        r"(?!(?-i:"
        r"The|Patient|Customer|Member|Owner|Holder|Sender|"
        r"Recipient|Beneficiary|Plaintiff|Defendant|Witness|Suspect|"
        r"Buyer|Seller|Donor|Sponsor|Applicant|Petitioner|Respondent|"
        r"Contact|Email|Send|Tell|Call|Reach|Reply|Mail|Forward|"
        r"Please|Kindly|Thank|Thanks|Regards|Best|Sincerely|"
        r"Confirm|Confirmed|Cancel|Cancelled|Approve|Reject|"
        r"Sign|Submit|Upload|Download|Save|Delete|Update|"
        r"Find|See|Note|Notice|Refer|Review|Schedule|Book|"
        r"Order|Pay|Charge|Issue|Deliver|Pick|Drop|Give|Take|Get|"
        r"Stop|Start|Begin|Continue|Resume|Open|Close|"
        # Report/list heading words, not organization names.
        r"Top|Senior|Junior|Total|Subtotal|Net|Gross|Average|Median"
        r")\s))"
        r"((?-i:[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,3})\s+"
        r"(?:Inc|Corp|Corporation|LLC|Ltd|Limited|GmbH|AG|SA|BV|NV|"
        r"AB|Oy|Plc|Group|Holdings|Industries|Partners|"
        r"Foundation|Trust|Bank|Capital|Company|Co|"
        # Business-activity suffixes common in B2B and shipping text.
        r"Trading|Logistics|Manufacturing|Solutions|Systems|"
        r"Services|Technologies|Enterprises|Consulting|Associates|"
        # Healthcare institution suffixes; hospital affiliations are sensitive.
        r"Hospital|Clinic|Healthcare|Medical\s+Center|Health\s+System"
        r")\.?)"
        r"(?!\w)"
    ),
    "JWT": r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?![A-Za-z0-9_-])",
    "EMAIL": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b",
    # PHONE: E.164, international, and NANP. Separators exclude newlines so
    # two numbers on adjacent lines are not merged.
    "PHONE": (
        r"\+\d{8,15}(?!\d)"
        r"|"
        r"\+\d{1,3}(?:[ \t\-\.()]*\d){7,14}(?!\d)"
        r"|"
        r"(?:\+?\d{1,3}[ \t\-\.]?)?\(?\d{3}\)?[ \t\-\.]\d{3}[ \t\-\.]\d{4}"
    ),
    "URL": r"https?://[^\s,;]+(?<![.,;:!?\"'>])",
    "IPV4": r"(?:\d{1,3}\.){3}\d{1,3}",
    "MAC": r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}",
    # ACCOUNT: 8-16 digit account-like identifier. If it overlaps ID_NUM,
    # stage-1 specificity chooses the ID pattern.
    "ACCOUNT": r"(?<!xox[baprs]-)\b(?<!\$)(?<!\€)(?<!\£)\d{8,16}\b(?!\s*(?:million|billion|thousand))",
    # ID_NUM: government / identity numbers.
    "ID_NUM": r"(?<!xox[baprs]-)\b(?:[A-Z]{2}\d{6}|[A-Z]\d{7,9}|\d{9,11})\b",
    "SSN": r"\b\d{3}-\d{2}-\d{4}\b",
    # ISO_DATE: YYYY-MM-DD with optional time component.
    "ISO_DATE": (
        r"\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])"
        r"(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?"
        r"(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?\b"
    ),
    # CITY_GAZETTEER: regex backstop for major world cities.
    "CITY_GAZETTEER": (
        r"\b(?-i:"
        r"London|Paris|Berlin|Madrid|Rome|Amsterdam|Brussels"
        r"|Vienna|Prague|Warsaw|Stockholm|Copenhagen|Helsinki"
        r"|Oslo|Dublin|Lisbon|Athens|Zurich|Geneva|Munich"
        r"|Frankfurt|Hamburg|Milan|Barcelona"
        r"|Tokyo|Beijing|Shanghai|Hong Kong|Singapore|Seoul"
        r"|Mumbai|Delhi|Bangalore|Karachi|Lagos|Cairo|Nairobi"
        r"|Johannesburg|Sydney|Melbourne|Auckland"
        r"|Moscow|Saint Petersburg|Istanbul|Dubai|Riyadh|Tehran"
        r"|Toronto|Montreal|Vancouver"
        r"|New York|Los Angeles|Chicago|Houston|Phoenix"
        r"|Philadelphia|San Antonio|San Diego|Dallas|Austin"
        r"|San Francisco|San Jose|Seattle|Denver|Boston"
        r"|Washington|Atlanta|Miami|Detroit|Minneapolis"
        r"|Mexico City|Buenos Aires|Sao Paulo|Rio de Janeiro"
        r"|Lima|Bogota|Santiago"
        r")\b"
    ),
    # JSON_CITY: city extracted from JSON webhook payloads.
    "JSON_CITY": (
        r"(?<=\"city\":\")[A-Z][\w\s.\-']{1,40}(?=\")"
        r"|"
        r"(?<=\"locality\":\")[A-Z][\w\s.\-']{1,40}(?=\")"
    ),
    # ZIP_CODE: US ZIP / ZIP+4 plus European postal-code-before-city.
    "ZIP_CODE": (
        r"\b\d{5}-\d{4}\b"
        r"|"
        r"(?:"
        r"(?<=(?-i:\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s))"
        r"\d{5}(?!\d)"
        r")"
        r"|"
        r"(?:(?<=\b(?:ZIP|zip|Zip)\s)\d{5}(?!\d))"
        r"|"
        r"(?:\b\d{5}\b(?=\s(?-i:[A-Z][a-zäöüßàâçéèêëîïôœùûÿ])))"
        r"|"
        r"(?-i:[A-Z][a-zäöüßàâçéèêëîïôœùûÿ]+),\s?(\d{5})(?!\d)"
    ),
    # API / Secrets
    "API_KEY": r"\b(?:api[_-]?key|access[_-]?token|secret)\b[\"'\s:=]+([A-Za-z0-9\-_]{16,64})\b",
    "BEARER_TOKEN": r"\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b",
    "AWS_ACCESS_KEY": r"\bAKIA[0-9A-Z]{16}\b",
    "PRIVATE_KEY": r"-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----",
    "GENERIC_TOKEN": r"\b[A-Za-z0-9_\-]{32,64}\b",
    "GITHUB_TOKEN": r"\bghp_[A-Za-z0-9]{36}\b",
    "SLACK_TOKEN": r"\bxox[baprs]-[A-Za-z0-9-]{10,48}\b",
    "STRIPE_KEY": r"\bsk_(live|test)_[A-Za-z0-9]{24,}\b",
}


FINANCIAL_PATTERNS: Dict[str, str] = {
    # Standalone percentages are not masked; they are not personal data by
    # themselves. FIN_AMOUNT covers common currency and magnitude formats,
    # while avoiding unit counts such as "8,107 shares".
    "FIN_AMOUNT": (
        r"(?<!\w)"
        r"(?:"
        # Shape 1: currency + US thousands-grouped amount + optional magnitude.
        r"(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|HKD|CNY|\$|€|£|¥)\s?"
        r"\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?"
        r"(?:\s+(?:million|billion|trillion|thousand)|(?:\s?[MBKTmbkt]))?"
        r"|"
        # Shape 1b: currency + EU-grouped amount (1.234.567,89).
        r"(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|HKD|CNY|\$|€|£|¥)\s?"
        r"\d{1,3}(?:\.\d{3})+(?:,\d+)?"
        r"|"
        # Shape 1c: EU-decimal amount + trailing currency symbol/word.
        r"\d{1,3}(?:\.\d{3})*,\d+\s?(?:€|£|\$|¥|dollars|euros|pounds|USD|EUR|GBP|CHF)"
        r"|"
        # Shape 2: currency + bare amount (any size) + optional magnitude.
        r"(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|HKD|CNY|\$|€|£|¥)\s?"
        r"\d+(?:\.\d+)?"
        r"(?:\s+(?:million|billion|trillion|thousand)|(?:\s?[MBKTmbkt]))?"
        r"|"
        # Shape 2b: bare amount + spelled/code currency suffix.
        r"\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s?(?:dollars|euros|pounds|USD|EUR|GBP|CHF)"
        r"|"
        # Shape 3: bare comma-grouped number, unless a unit word follows it
        # (a count like "8,107 shares" / "500 units" is not a monetary amount).
        r"\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\s+(?:shares?|units?|items?|people|employees|users?))"
        r"|"
        # Shape 4: bare number + magnitude word.
        r"\d+(?:\.\d+)?\s+(?:million|billion|trillion|thousand)"
        r")"
        r"(?!\w)"
    ),
}


FINANCIAL_KEYWORDS: List[str] = [
    "roi",
    "ebitda",
    "valuation",
    "funding",
    "contract",
    # "invoice" is too common and not sensitive by itself.
    "p&l",
    "balance sheet",
    "income statement",
    "capex",
    "opex",
]


# Maps raw detector labels to canonical placeholder categories. Placeholder
# numbering is per category, so labels like GIVENNAME and SURNAME both share
# the PERSON counter.
LABEL_CATEGORY_MAP: Dict[str, str] = {
    # private_person
    "GIVENNAME":        "PERSON",
    "SURNAME":          "PERSON",
    "TITLE":            "PERSON",
    "PERSON":           "PERSON",
    "private_person":   "PERSON",
    # private_email
    "EMAIL":            "EMAIL",
    "private_email":    "EMAIL",
    # private_phone
    "PHONE":            "PHONE",
    "TELEPHONENUM":     "PHONE",
    "private_phone":    "PHONE",
    # private_url
    "URL":              "URL",
    "IPV4":             "URL",
    "MAC":              "URL",
    "private_url":      "URL",
    # private_dateTime
    "DATE":             "DATETIME",
    "TIME":             "DATETIME",
    "ISO_DATE":         "DATETIME",
    "private_date":     "DATETIME",
    # PPLX-only labels
    "private_address":  "ADDRESS",
    "account_number":   "FINANCIAL",
    "secret":           "SECRET",
    "other_pii":        "OTHER_PII",
    # private_id
    "IDCARDNUM":        "ID",
    "SOCIALNUM":        "ID",
    "ID_NUM":           "ID",
    "SSN":              "ID",
    "DRIVERLICENSENUM": "ID",
    "PASSPORTNUM":      "ID",
    # org
    "ORG":              "ORG",
    "ORG_NAME":         "ORG",
    "ORG_GAZETTEER":    "ORG",
    "COMPANYNAME":      "ORG",
    # person regex backstops
    "ROLE_PERSON":      "PERSON",
    # demographic regex backstops
    "SEX_VALUE":        "SEX",
    "GENDER_VALUE":     "GENDER",
    "COUNTRY_NAME":     "COUNTRY",
    "COUNTY_NAME":      "COUNTY",
    # financial
    "CREDITCARDNUM":    "FINANCIAL",
    "CREDITCARDNUMBER": "FINANCIAL",
    "IBAN":             "FINANCIAL",
    "TAXNUM":           "FINANCIAL",
    "FIN_AMOUNT":       "FINANCIAL",
    "FIN_TERM":         "FINANCIAL",
    "FIN_SENSITIVE_SENT": "FINANCIAL",
    # secret
    "JWT":              "SECRET",
    "API_KEY":          "SECRET",
    "BEARER_TOKEN":     "SECRET",
    "AWS_ACCESS_KEY":   "SECRET",
    "PRIVATE_KEY":      "SECRET",
    "GENERIC_TOKEN":    "SECRET",
    "GITHUB_TOKEN":     "SECRET",
    "SLACK_TOKEN":      "SECRET",
    "STRIPE_KEY":       "SECRET",
    "ACCOUNT":          "SECRET",
    # pass-through
    "STREET":           "STREET",
    "BUILDINGNUM":      "BUILDINGNUM",
    "ZIPCODE":          "ZIPCODE",
    "ZIP_CODE":         "ZIPCODE",
    "CITY":             "CITY",
    "JSON_CITY":        "CITY",
    "CITY_GAZETTEER":   "CITY",
    "AGE":              "AGE",
    "SEX":              "SEX",
    "GENDER":           "GENDER",
    "COUNTRY":          "COUNTRY",
    "COUNTY":           "COUNTY",
}


# Categories skipped in Medium mode because they are treated as public enough.
MEDIUM_SKIP_CATEGORIES: Set[str] = {
    "PERSON",
    "ORG",
    "CITY",
    "COUNTRY",
    "COUNTY",
}
