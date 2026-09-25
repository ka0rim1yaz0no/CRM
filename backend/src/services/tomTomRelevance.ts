export type TomTomRelevancePlace = {
  businessName: string;
  businessAddress?: string;
  providerCategory?: string;
  municipality?: string;
  countrySubdivision?: string;
  latitude?: number;
  longitude?: number;
};

export type TomTomRelevanceResult = {
  relevant: boolean;
  score: number;
  reason: string;
};

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "at", "best", "business", "businesses", "buyer", "buyers", "company", "companies",
  "for", "in", "local", "me", "my", "near", "of", "place", "places", "product", "products", "the", "to", "top", "with",
]);

const GENERIC_BUSINESS_WORDS = new Set([
  "center", "centre", "dealer", "distributor", "location", "outlet", "provider", "retailer", "service", "services",
  "shop", "shops", "store", "stores", "supplier", "suppliers", "venue", "venues",
]);

const US_STATE_CODES_BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const US_STATE_CODES = new Set(Object.values(US_STATE_CODES_BY_NAME));

const RELEVANCE_FAMILIES = [
  ["movie theater", "movie theatre", "cinema", "multiplex", "drive in theater"],
  ["shopping mall", "mall", "shopping center", "shopping centre", "outlet mall"],
  ["arcade", "video arcade", "amusement arcade", "gaming center"],
  ["bowling alley", "bowling center", "bowling"],
  ["family entertainment center", "family fun center", "amusement center", "indoor playground"],
  ["trampoline park", "trampoline center"],
  ["roller skating rink", "ice skating rink", "skating rink", "skate center"],
  ["event venue", "event center", "convention center", "banquet hall", "conference center"],
  ["college student center", "student center", "college", "university", "campus"],
  ["laundromat", "laundry", "coin laundry", "washateria"],
  ["cannabis", "marijuana", "dispensary", "hemp", "cbd"],
  ["vending machine", "vending", "automatic retailer"],
  ["coffee shop", "coffeehouse", "cafe", "café"],
  ["restaurant", "diner", "eatery", "food court"],
  ["bar", "pub", "tavern", "nightclub", "cocktail lounge"],
  ["gym", "fitness center", "health club", "workout center"],
  ["pharmacy", "drugstore", "chemist"],
  ["hotel", "motel", "resort", "lodging"],
  ["hospital", "medical clinic", "health clinic", "medical center", "urgent care"],
  ["school", "academy", "education center", "learning center"],
  ["grocery store", "supermarket", "food market"],
  ["retail store", "retail", "department store", "general merchandise"],
  ["gas station", "fuel station", "service station", "petrol station"],
  ["car dealership", "auto dealer", "automobile dealer", "vehicle dealer"],
  ["dentist", "dental clinic", "dental office"],
  ["hair salon", "beauty salon", "barbershop", "spa", "nail salon"],
  ["daycare", "child care", "preschool", "nursery school"],
  ["church", "place of worship", "religious center"],
  ["warehouse", "distribution center", "fulfillment center"],
  ["pet groomer", "pet grooming", "pet store", "veterinarian", "animal hospital"],
] as const;

function normalizeText(value: string) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stemToken(value: string) {
  if (value.length > 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 6 && value.endsWith("sses")) return value.slice(0, -2);
  if (value.length > 5 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function tokens(value: string, includeGeneric = false) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token))
    .filter((token) => includeGeneric || !GENERIC_BUSINESS_WORDS.has(token))
    .map(stemToken);
}

function tokenMatches(queryToken: string, evidenceToken: string) {
  if (queryToken === evidenceToken) return true;
  const shortestLength = Math.min(queryToken.length, evidenceToken.length);
  return shortestLength >= 5 && (queryToken.startsWith(evidenceToken) || evidenceToken.startsWith(queryToken));
}

function signalMatches(text: string, signal: string) {
  const normalizedText = normalizeText(text);
  const normalizedSignal = normalizeText(signal);
  if (!normalizedSignal) return false;
  if (` ${normalizedText} `.includes(` ${normalizedSignal} `)) return true;

  const textTokens = tokens(normalizedText, true);
  const signalTokens = tokens(normalizedSignal, true);
  return signalTokens.length > 0 && signalTokens.every((signalToken) =>
    textTokens.some((textToken) => tokenMatches(signalToken, textToken))
  );
}

function normalizeUsStateCode(value: string) {
  const rawValue = String(value || "").trim();
  const upperValue = rawValue.toUpperCase();
  if (US_STATE_CODES.has(upperValue)) return upperValue;
  return US_STATE_CODES_BY_NAME[normalizeText(rawValue)] || "";
}

function extractUsStateCodeFromAddress(address: string) {
  const addressText = String(address || "").trim();
  if (!addressText) return "";

  const addressParts = addressText.split(",").map((part) => part.trim()).filter(Boolean).reverse();
  for (const part of addressParts) {
    const partWithoutZip = part.replace(/\b\d{5}(?:-\d{4})?\b/g, "").trim();
    const fullPartCode = normalizeUsStateCode(partWithoutZip);
    if (fullPartCode) return fullPartCode;

    const stateCodeTokens = partWithoutZip.match(/\b[A-Z]{2}\b/g) || [];
    const stateCode = stateCodeTokens.find((token) => US_STATE_CODES.has(token));
    if (stateCode) return stateCode;
  }

  const normalizedAddress = normalizeText(addressText);
  for (const [stateName, stateCode] of Object.entries(US_STATE_CODES_BY_NAME)) {
    if (` ${normalizedAddress} `.includes(` ${stateName} `)) return stateCode;
  }

  return "";
}

function matchedQueryFamilies(query: string) {
  return RELEVANCE_FAMILIES.filter((family) => family.some((signal) => signalMatches(query, signal)));
}

function familyCoveredQueryTokens(query: string, families: typeof RELEVANCE_FAMILIES[number][]) {
  const covered = new Set<string>();
  families.forEach((family) => {
    family.filter((signal) => signalMatches(query, signal)).forEach((signal) => {
      tokens(signal, true).forEach((token) => covered.add(token));
    });
  });
  return covered;
}

export function isSpecificTomTomSearchQuery(query: string) {
  const families = matchedQueryFamilies(query);
  return families.length > 0 || tokens(query).length > 0;
}

export function evaluateTomTomPlaceRelevance(place: TomTomRelevancePlace, query: string): TomTomRelevanceResult {
  const normalizedQuery = normalizeText(query);
  const evidence = normalizeText(`${place.businessName} ${place.providerCategory || ""}`);

  if (!normalizedQuery || !evidence) {
    return { relevant: false, score: 0, reason: "missing query or business category evidence" };
  }

  if (` ${evidence} `.includes(` ${normalizedQuery} `)) {
    return { relevant: true, score: 100, reason: "exact query phrase matched the business name or category" };
  }

  const families = matchedQueryFamilies(normalizedQuery);
  const evidenceTokens = tokens(evidence, true);
  const meaningfulQueryTokens = Array.from(new Set(tokens(normalizedQuery)));

  if (families.length > 0) {
    const unmatchedFamilies = families.filter((family) => !family.some((signal) => signalMatches(evidence, signal)));
    if (unmatchedFamilies.length > 0) {
      return { relevant: false, score: 0, reason: "TomTom category did not match the requested business type" };
    }

    const coveredTokens = familyCoveredQueryTokens(normalizedQuery, families);
    const extraTokens = meaningfulQueryTokens.filter((token) => !Array.from(coveredTokens).some((covered) => tokenMatches(token, covered)));
    const missingExtraTokens = extraTokens.filter((queryToken) =>
      !evidenceTokens.some((evidenceToken) => tokenMatches(queryToken, evidenceToken))
    );

    if (missingExtraTokens.length > 0) {
      return {
        relevant: false,
        score: 0,
        reason: `business did not match the specific term${missingExtraTokens.length === 1 ? "" : "s"}: ${missingExtraTokens.join(", ")}`,
      };
    }

    return {
      relevant: true,
      score: extraTokens.length > 0 ? 96 : 92,
      reason: "TomTom category matched the requested business type",
    };
  }

  if (meaningfulQueryTokens.length === 0) {
    return { relevant: false, score: 0, reason: "query is too broad to validate accurately" };
  }

  const missingTokens = meaningfulQueryTokens.filter((queryToken) =>
    !evidenceTokens.some((evidenceToken) => tokenMatches(queryToken, evidenceToken))
  );

  if (missingTokens.length > 0) {
    return {
      relevant: false,
      score: 0,
      reason: `business did not match the specific term${missingTokens.length === 1 ? "" : "s"}: ${missingTokens.join(", ")}`,
    };
  }

  return { relevant: true, score: 90, reason: "all meaningful query terms matched the business name or category" };
}

export function distanceBetweenCoordinatesMiles(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
) {
  const earthRadiusMiles = 3958.7613;
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(haversine));
}

export function isTomTomPlaceWithinRadius(
  place: TomTomRelevancePlace,
  center: { latitude: number; longitude: number },
  radiusMiles: number
) {
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || radiusMiles <= 0) return false;
  return distanceBetweenCoordinatesMiles(center, {
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
  }) <= radiusMiles;
}

export function matchesTomTomLocationLabel(place: TomTomRelevancePlace, locationLabel: string) {
  const [requestedCity = ""] = String(locationLabel || "").split(",").map((part) => normalizeText(part));
  const cityEvidence = normalizeText(`${place.municipality || ""} ${place.businessAddress || ""}`);
  const cityMatches = !requestedCity || signalMatches(cityEvidence, requestedCity);
  return cityMatches && matchesTomTomRequestedRegion(place, locationLabel);
}

export function matchesTomTomRequestedRegion(place: TomTomRelevancePlace, locationLabel: string) {
  const [, requestedRegion = ""] = String(locationLabel || "").split(",").map((part) => part.trim());
  if (!requestedRegion) return true;

  const requestedStateCode = normalizeUsStateCode(requestedRegion);
  if (!requestedStateCode) {
    return signalMatches(`${place.countrySubdivision || ""} ${place.businessAddress || ""}`, requestedRegion);
  }

  const providerStateCode = normalizeUsStateCode(place.countrySubdivision || "")
    || extractUsStateCodeFromAddress(place.businessAddress || "");
  return providerStateCode === requestedStateCode;
}
