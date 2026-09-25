import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTomTomPlaceRelevance,
  isSpecificTomTomSearchQuery,
  isTomTomPlaceWithinRadius,
  matchesTomTomLocationLabel,
  matchesTomTomRequestedRegion,
} from "./tomTomRelevance";

test("accepts a provider category aligned with the requested venue", () => {
  const result = evaluateTomTomPlaceRelevance(
    { businessName: "AMC North", providerCategory: "Cinema" },
    "movie theaters"
  );
  assert.equal(result.relevant, true);
  assert.ok(result.score >= 90);
});

test("rejects an unrelated provider category", () => {
  const result = evaluateTomTomPlaceRelevance(
    { businessName: "Central Care", providerCategory: "Pharmacy" },
    "movie theaters"
  );
  assert.equal(result.relevant, false);
});

test("accepts category synonyms and rejects a generic shop", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Green Leaf", providerCategory: "Cannabis Dispensary" },
    "hemp shop"
  ).relevant, true);
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Corner Market", providerCategory: "Convenience Store" },
    "hemp shop"
  ).relevant, false);
});

test("requires extra product words beyond a broad category family", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Popcorn Vending Solutions", providerCategory: "Vending Machine Supplier" },
    "popcorn vending machine"
  ).relevant, true);
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Office Refreshments", providerCategory: "Vending Machine Supplier" },
    "popcorn vending machine"
  ).relevant, false);
});

test("rejects popcorn businesses when the requested business type is vape shops", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Popcorn Vending Solutions", providerCategory: "Vending Machine Supplier" },
    "vape shops"
  ).relevant, false);
});

test("requires every distinct business family named in the query", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Main Street Pharmacy", providerCategory: "Pharmacy" },
    "pet store pharmacy"
  ).relevant, false);
});

test("requires every meaningful word for an unknown product search", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Bright Solar Panel Warehouse", providerCategory: "Energy Equipment Supplier" },
    "solar panel suppliers"
  ).relevant, true);
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Neighborhood Hardware", providerCategory: "Hardware Store" },
    "solar panel suppliers"
  ).relevant, false);
});

test("allows grammatical category variants", () => {
  assert.equal(evaluateTomTomPlaceRelevance(
    { businessName: "Happy Paws", providerCategory: "Pet Groomer" },
    "pet grooming services"
  ).relevant, true);
});

test("rejects broad queries that cannot be checked accurately", () => {
  assert.equal(isSpecificTomTomSearchQuery("businesses near me"), false);
  assert.equal(isSpecificTomTomSearchQuery("retail stores"), true);
});

test("enforces the requested geographic radius", () => {
  const center = { latitude: 30.2672, longitude: -97.7431 };
  assert.equal(isTomTomPlaceWithinRadius({
    businessName: "Near Austin",
    latitude: 30.3,
    longitude: -97.75,
  }, center, 10), true);
  assert.equal(isTomTomPlaceWithinRadius({
    businessName: "Dallas Business",
    latitude: 32.7767,
    longitude: -96.797,
  }, center, 10), false);
});

test("uses city and state evidence when geocoding is unavailable", () => {
  assert.equal(matchesTomTomLocationLabel({
    businessName: "Local Business",
    businessAddress: "123 Main St, Austin, TX 78701",
    municipality: "Austin",
    countrySubdivision: "TX",
  }, "Austin, TX"), true);
  assert.equal(matchesTomTomLocationLabel({
    businessName: "Remote Business",
    businessAddress: "Dallas, TX",
    municipality: "Dallas",
    countrySubdivision: "TX",
  }, "Austin, TX"), false);
});

test("requires the requested state even when a result is inside the search radius", () => {
  assert.equal(matchesTomTomRequestedRegion({
    businessName: "Texas Business",
    businessAddress: "500 Texas Ave, El Paso, TX 79901",
    countrySubdivision: "Texas",
  }, "El Paso, TX"), true);
  assert.equal(matchesTomTomRequestedRegion({
    businessName: "Border Business",
    businessAddress: "1051 McNutt Road, Sunland Park, NM 88063",
    countrySubdivision: "New Mexico",
  }, "El Paso, TX"), false);
});
