import assert from "node:assert/strict";
import test from "node:test";
import { mapTomTomLegacyPlace, mapTomTomOrbisPlace } from "./tomTomSearchService";

test("maps an Orbis Discover POI into a callable CRM lead", () => {
  const place = mapTomTomOrbisPlace({
    id: "place-123",
    type: "poi",
    title: "Example Vape Shop",
    subtitles: ["100 Main St", "Houston, TX 77002", "United States"],
    position: { coordinates: [-95.36, 29.76] },
    address: {
      municipality: "Houston",
      countrySubdivision: "Texas",
    },
    poiTypes: [
      { id: "specialty_shop", name: "Specialty Shop" },
      { id: "tobacco_shop", name: "Tobacco Shop" },
    ],
    contacts: [
      { phones: ["+1 713-555-0100"], websites: ["https://example.test"] },
    ],
  });

  assert.deepEqual(place, {
    provider: "tomtom",
    providerPlaceId: "place-123",
    googlePlaceId: "",
    businessName: "Example Vape Shop",
    businessAddress: "100 Main St, Houston, TX 77002, United States",
    phone: "+1 713-555-0100",
    website: "https://example.test",
    latitude: 29.76,
    longitude: -95.36,
    providerCategory: "Specialty Shop, Tobacco Shop",
    municipality: "Houston",
    countrySubdivision: "Texas",
  });
});

test("rejects non-POI Orbis Discover results", () => {
  assert.equal(mapTomTomOrbisPlace({ id: "area-1", type: "area", title: "Houston" }), null);
});

test("maps a legacy Search API POI into the same CRM lead shape", () => {
  const place = mapTomTomLegacyPlace({
    id: "legacy-place-123",
    type: "POI",
    poi: {
      name: "Legacy Smoke Shop",
      phone: "+1 713-555-0199",
      url: "https://legacy.example.test",
      classifications: [{ names: [{ name: "Tobacco Shop" }] }],
    },
    address: {
      freeformAddress: "200 Main St, Houston, TX 77002",
      municipality: "Houston",
      countrySubdivision: "TX",
    },
    position: { lat: 29.75, lon: -95.37 },
  });

  assert.deepEqual(place, {
    provider: "tomtom",
    providerPlaceId: "legacy-place-123",
    googlePlaceId: "",
    businessName: "Legacy Smoke Shop",
    businessAddress: "200 Main St, Houston, TX 77002",
    phone: "+1 713-555-0199",
    website: "https://legacy.example.test",
    latitude: 29.75,
    longitude: -95.37,
    providerCategory: "Tobacco Shop",
    municipality: "Houston",
    countrySubdivision: "TX",
  });
});

test("rejects non-POI legacy Search API results", () => {
  assert.equal(mapTomTomLegacyPlace({ id: "address-1", type: "Point Address" }), null);
});
