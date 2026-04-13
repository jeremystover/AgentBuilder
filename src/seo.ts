// JSON-LD structured data builders.  These produce Schema.org objects
// that get embedded in SSR pages so Google (and other search engines)
// can read vacation-rental listings for rich results without having
// to execute client-side JavaScript.
//
// Reference: https://developers.google.com/search/docs/appearance/structured-data/vacation-rental
//
// We intentionally emit only fields we have data for; Google tolerates
// missing optional fields but warns about missing required ones in
// Search Console.  Add latitude/longitude and floorSize as the schema
// grows.

import type { Unit, Property, Photo, Review } from "./types";

export interface SeoContext {
  baseUrl: string;   // "https://www.thewhitfordhouse.com"
  brandName: string; // "The Whitford House"
}

type JsonLd = Record<string, unknown>;

/** Aggregate (avg rating + count) computed from a list of Reviews. */
export interface ReviewAggregate {
  ratingValue: number;
  reviewCount: number;
}

export function aggregateReviews(reviews: Review[]): ReviewAggregate | undefined {
  const published = reviews.filter(r => r.published);
  if (published.length === 0) return undefined;
  const sum = published.reduce((acc, r) => acc + r.rating, 0);
  return {
    ratingValue: Math.round((sum / published.length) * 10) / 10,
    reviewCount: published.length,
  };
}

function prune<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

function photoUrls(photos: Array<{ id: number }>, base: string): string[] {
  return photos.map(p => `${base}/photos/${p.id}`);
}

function parseAmenities(json: string | null): JsonLd[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return undefined;
    return arr.map((name: string) => ({
      "@type": "LocationFeatureSpecification",
      name,
      value: true,
    }));
  } catch { return undefined; }
}

function addressLd(property: Property): JsonLd | undefined {
  if (!property.address && !property.locality && !property.region) return undefined;
  return prune({
    "@type": "PostalAddress",
    streetAddress:   property.address ?? undefined,
    addressLocality: property.locality ?? undefined,
    addressRegion:   property.region ?? undefined,
    postalCode:      property.postal_code ?? undefined,
    addressCountry:  property.country ?? "US",
  });
}

function geoLd(property: Property): JsonLd | undefined {
  if (property.latitude == null || property.longitude == null) return undefined;
  return {
    "@type": "GeoCoordinates",
    latitude: property.latitude,
    longitude: property.longitude,
  };
}

function mapUrl(property: Property): string | undefined {
  if (property.latitude == null || property.longitude == null) return undefined;
  return `https://www.google.com/maps/?q=${property.latitude},${property.longitude}`;
}

function reviewLd(r: Review): JsonLd {
  return prune({
    "@type": "Review",
    reviewRating: {
      "@type": "Rating",
      ratingValue: r.rating,
      bestRating: 5,
      worstRating: 1,
    },
    author: { "@type": "Person", name: r.author_name },
    datePublished: (r.stay_date ?? r.created_at ?? "").slice(0, 10) || undefined,
    name: r.title ?? undefined,
    reviewBody: r.body ?? undefined,
  });
}

function aggregateRatingLd(agg: ReviewAggregate | undefined): JsonLd | undefined {
  if (!agg) return undefined;
  return {
    "@type": "AggregateRating",
    ratingValue: agg.ratingValue,
    reviewCount: agg.reviewCount,
    bestRating: 5,
    worstRating: 1,
  };
}

function offerLd(unit: Unit, url: string): JsonLd | undefined {
  if (unit.base_price == null) return undefined;
  return {
    "@type": "Offer",
    priceCurrency: "USD",
    price: unit.base_price,
    availability: "https://schema.org/InStock",
    url,
    validFrom: new Date().toISOString().slice(0, 10),
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: unit.base_price,
      priceCurrency: "USD",
      unitCode: "DAY",
      referenceQuantity: {
        "@type": "QuantitativeValue",
        value: 1,
        unitCode: "DAY",
      },
    },
  };
}

/** VacationRental for a single unit detail page. */
export function buildVacationRentalLd(
  unit: Unit,
  photos: Array<{ id: number }>,
  property: Property,
  ctx: SeoContext,
  reviews: Review[] = []
): JsonLd {
  const url = `${ctx.baseUrl}/book/unit/${unit.id}`;
  const images = photoUrls(photos, ctx.baseUrl);
  const agg = aggregateReviews(reviews);
  const published = reviews.filter(r => r.published).slice(0, 10);
  return prune({
    "@context": "https://schema.org",
    "@type": "VacationRental",
    // additionalType signals to Google that this is specifically a
    // vacation rental (vs a generic LodgingBusiness).
    additionalType: "https://schema.org/VacationRental",
    "@id": url,
    url,
    name: `${property.name} — ${unit.name}`,
    description: unit.description
      ?? `${unit.bedrooms ? unit.bedrooms + "-bedroom " : ""}vacation rental at ${ctx.brandName}.`,
    image: images.length ? images : undefined,
    brand: {
      "@type": "Organization",
      name: ctx.brandName,
      url: ctx.baseUrl,
    },
    identifier: `whitford-unit-${unit.id}`,
    numberOfBedrooms: unit.bedrooms ?? undefined,
    numberOfRooms: unit.bedrooms ?? undefined,
    numberOfBathroomsTotal: unit.bathrooms ?? undefined,
    occupancy: unit.sleeps ? {
      "@type": "QuantitativeValue",
      value: unit.sleeps,
    } : undefined,
    address: addressLd(property),
    geo: geoLd(property),
    hasMap: mapUrl(property),
    amenityFeature: parseAmenities(unit.amenities_json),
    offers: offerLd(unit, url),
    aggregateRating: aggregateRatingLd(agg),
    review: published.length ? published.map(reviewLd) : undefined,
  });
}

/** LodgingBusiness for the overall property on the /book list page. */
export function buildLodgingBusinessLd(
  units: Unit[],
  photosByUnit: Map<number, Array<{ id: number }>>,
  properties: Map<number, Property>,
  ctx: SeoContext,
  reviewsByProperty: Map<number, Review[]> = new Map()
): JsonLd {
  const firstProp = [...properties.values()][0];
  // Merge all property-level reviews so the top-level LodgingBusiness
  // gets a single aggregate rating across the whole operation.
  const allReviews: Review[] = [];
  for (const rs of reviewsByProperty.values()) allReviews.push(...rs);
  const agg = aggregateReviews(allReviews);

  return prune({
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    "@id": `${ctx.baseUrl}#lodging`,
    name: ctx.brandName,
    url: ctx.baseUrl,
    description: `Book direct for your stay at ${ctx.brandName}. Guest house and whole-house or individual rooms in the main house.`,
    brand: {
      "@type": "Organization",
      name: ctx.brandName,
      url: ctx.baseUrl,
    },
    address: firstProp ? addressLd(firstProp) : undefined,
    geo: firstProp ? geoLd(firstProp) : undefined,
    hasMap: firstProp ? mapUrl(firstProp) : undefined,
    aggregateRating: aggregateRatingLd(agg),
    containsPlace: units.map(u => {
      const url = `${ctx.baseUrl}/book/unit/${u.id}`;
      const photos = photosByUnit.get(u.id) ?? [];
      const prop = properties.get(u.property_id);
      const unitReviews = prop ? (reviewsByProperty.get(prop.id) ?? []) : [];
      const unitAgg = aggregateReviews(unitReviews);
      return prune({
        "@type": "VacationRental",
        additionalType: "https://schema.org/VacationRental",
        "@id": url,
        name: u.name,
        url,
        image: photos[0] ? `${ctx.baseUrl}/photos/${photos[0].id}` : undefined,
        numberOfBedrooms: u.bedrooms ?? undefined,
        numberOfRooms: u.bedrooms ?? undefined,
        occupancy: u.sleeps ? {
          "@type": "QuantitativeValue",
          value: u.sleeps,
        } : undefined,
        address: prop ? addressLd(prop) : undefined,
        geo: prop ? geoLd(prop) : undefined,
        offers: offerLd(u, url),
        aggregateRating: aggregateRatingLd(unitAgg),
      });
    }),
  });
}

/** BreadcrumbList for a unit detail page (Home › Book › Unit name). */
export function buildBreadcrumbLd(unit: Unit, ctx: SeoContext): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: ctx.brandName, item: ctx.baseUrl },
      { "@type": "ListItem", position: 2, name: "Book", item: `${ctx.baseUrl}/book` },
      { "@type": "ListItem", position: 3, name: unit.name, item: `${ctx.baseUrl}/book/unit/${unit.id}` },
    ],
  };
}
