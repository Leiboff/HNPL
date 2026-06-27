'use client';

// ─── Google Places API (New) — client-side wrapper ──────────────────────
//
// Replaces the legacy Geocoding API on every address/location surface.
// Two endpoints + a session token are the entire integration:
//
//   • Autocomplete (New)
//       POST https://places.googleapis.com/v1/places:autocomplete
//       body: { input, sessionToken, includedRegionCodes:['za'],
//               includedPrimaryTypes? }
//
//   • Place Details (New)
//       GET  https://places.googleapis.com/v1/places/{placeId}
//            ?sessionToken=<token>
//       headers: X-Goog-Api-Key, X-Goog-FieldMask
//
// Session-token cost discipline (the standard Places billing pattern):
//   • Mint ONE token (UUID v4) at the start of a fresh autocomplete
//     interaction.
//   • Pass THAT SAME TOKEN on every Autocomplete request as the user
//     types AND on the terminating Place Details request.
//   • MINT A FRESH TOKEN after each Place Details fetch — the previous
//     one is consumed by the selection.
//   Without this, every keystroke bills as its own session.
//
// Field mask on Place Details (Essentials SKU only):
//   id, location, formattedAddress, addressComponents
//   Do NOT request Pro/Atmosphere fields (reviews, photos, etc.).
//
// Key: NEXT_PUBLIC_GOOGLE_PLACES_KEY. This IS browser-exposed (Places
// runs client-side; the dropdown lives in the page). The key MUST be
// HTTP-referrer-restricted in GCP to betternow.co.za + Vercel preview
// domains AND restricted to "Places API (New)" only. The old server-
// side GOOGLE_MAPS_API_KEY is retired with this commit.

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_BASE     = 'https://places.googleapis.com/v1/places';

// Essentials-tier fields only. Anything more requests Pro SKU.
const PLACE_DETAILS_FIELD_MASK = 'id,location,formattedAddress,addressComponents';

export type PlaceSuggestion = {
  placeId:       string;
  primaryText:   string;
  secondaryText: string;
};

export type AddressComponent = {
  longText:  string;
  shortText: string;
  types:     string[];
};

export type PlaceDetails = {
  placeId:           string;
  formattedAddress:  string;
  latitude:          number;
  longitude:         number;
  addressComponents: AddressComponent[];
};

// ─── Session-token helpers ──────────────────────────────────────────────

/**
 * Mint a fresh session token (UUID v4) for a new autocomplete
 * interaction. Call this once when the user starts typing and again
 * after each Place Details fetch (the previous token is consumed by
 * the selection — re-using it would bill the next interaction at
 * per-keystroke rates).
 */
export function newSessionToken(): string {
  return crypto.randomUUID();
}

// ─── Autocomplete ───────────────────────────────────────────────────────

export type AutocompleteOptions = {
  /**
   * Bias to specific primary types. For full street addresses leave
   * empty (Google's default ranking is correct). For suburb/locality
   * pickers pass ['locality', 'sublocality'] so the dropdown surfaces
   * areas, not individual street addresses.
   */
  includedPrimaryTypes?: string[];
};

/**
 * Fire one Autocomplete (New) request. Restricted to South Africa via
 * `includedRegionCodes:['za']`. Returns suggestions array (possibly
 * empty); returns empty on missing key / missing input / network
 * failure — never throws so the UI can render "no matches" without
 * crashing the picker.
 */
export async function autocompletePlaces(
  input: string,
  sessionToken: string,
  options: AutocompleteOptions = {},
): Promise<PlaceSuggestion[]> {
  const apiKey  = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
  const trimmed = input.trim();
  if (!apiKey || !trimmed) return [];

  const body: Record<string, unknown> = {
    input:               trimmed,
    sessionToken,
    includedRegionCodes: ['za'],
  };
  if (options.includedPrimaryTypes && options.includedPrimaryTypes.length > 0) {
    body.includedPrimaryTypes = options.includedPrimaryTypes;
  }

  try {
    const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[places] autocomplete non-2xx', { status: res.status });
      return [];
    }
    const data = (await res.json().catch(() => null)) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId:          string;
          structuredFormat?: {
            mainText?:      { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    } | null;

    const raw = data?.suggestions ?? [];
    return raw
      .filter((s) => !!s.placePrediction)
      .map((s) => ({
        placeId:       s.placePrediction!.placeId,
        primaryText:   s.placePrediction!.structuredFormat?.mainText?.text   ?? '',
        secondaryText: s.placePrediction!.structuredFormat?.secondaryText?.text ?? '',
      }));
  } catch (err) {
    console.warn('[places] autocomplete failed', { message: (err as Error).message });
    return [];
  }
}

// ─── Place Details (terminating request — consumes the session token) ──

/**
 * Fetch the chosen place's coords + formatted address. PASSES THE SAME
 * sessionToken used by the autocomplete requests — that's what makes
 * the whole interaction one billable session.
 *
 * After this resolves, the caller MUST mint a fresh token via
 * newSessionToken() for the next interaction (we don't reset
 * internally because the picker component is what owns the token's
 * lifecycle).
 *
 * The field mask is the Essentials-SKU minimum: id, location,
 * formattedAddress, addressComponents.
 */
export async function fetchPlaceDetails(
  placeId: string,
  sessionToken: string,
): Promise<PlaceDetails | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
  if (!apiKey || !placeId) return null;

  const url = `${PLACES_DETAILS_BASE}/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key':    apiKey,
        'X-Goog-FieldMask':  PLACE_DETAILS_FIELD_MASK,
      },
    });
    if (!res.ok) {
      console.warn('[places] details non-2xx', { status: res.status });
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      id?:                string;
      formattedAddress?:  string;
      location?:          { latitude?: number; longitude?: number };
      addressComponents?: AddressComponent[];
    } | null;
    if (!data?.location || typeof data.location.latitude !== 'number' || typeof data.location.longitude !== 'number') {
      return null;
    }
    return {
      placeId:           data.id ?? placeId,
      formattedAddress:  data.formattedAddress ?? '',
      latitude:          data.location.latitude,
      longitude:         data.location.longitude,
      addressComponents: data.addressComponents ?? [],
    };
  } catch (err) {
    console.warn('[places] details failed', { message: (err as Error).message });
    return null;
  }
}

// ─── Address-component helpers ─────────────────────────────────────────

/**
 * Pluck the first component matching any of the given type tags.
 * Returns longText when found, else null.
 */
export function pluckComponent(components: AddressComponent[], ...types: string[]): string | null {
  for (const c of components) {
    if (c.types.some((t) => types.includes(t))) return c.longText;
  }
  return null;
}

/**
 * Best-effort structured-address extraction from a Place Details
 * response. The components Google returns vary by place — be defensive
 * (every field is nullable).
 *
 * Returns {addressLine1, suburb, city, province, postalCode} suitable
 * for the existing practices.* columns. Used by the signup action and
 * the admin re-pick action to keep the structured columns populated
 * alongside the formattedAddress.
 */
export function parseAddressComponents(components: AddressComponent[]): {
  addressLine1: string | null;
  suburb:       string | null;
  city:         string | null;
  province:     string | null;
  postalCode:   string | null;
} {
  const streetNumber = pluckComponent(components, 'street_number');
  const route        = pluckComponent(components, 'route');
  const addressLine1 =
    streetNumber && route ? `${streetNumber} ${route}` :
    route                 ? route :
                            null;

  return {
    addressLine1,
    suburb:     pluckComponent(components, 'sublocality_level_1', 'sublocality', 'neighborhood'),
    city:       pluckComponent(components, 'locality', 'administrative_area_level_2'),
    province:   pluckComponent(components, 'administrative_area_level_1'),
    postalCode: pluckComponent(components, 'postal_code'),
  };
}
