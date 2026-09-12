import { createProviders } from '../src/providers.mjs';
import { createKyivProvider } from '../src/kyiv.mjs';

// Read-only public data checks. No bot token, user locations or messages.
const providers = createProviders();
const results = {};
try {
  const places = await providers.searchPlaces('Київ');
  results.places = { ok: places.length > 0, count: places.length };
} catch { results.places = { ok: false, error: 'Provider unavailable' }; }
try {
  const stops = await providers.nearbyStops(50.4501, 30.5234);
  results.stops = { ok: stops.length > 0, count: stops.length, example: stops[0]?.name };
  if (stops[0]) {
    const routes = await providers.stopRoutes(stops[0]);
    results.routes = { ok: true, count: routes.length, refs: routes.map(route => route.ref) };
  }
} catch { results.stops = { ok: false, error: 'Provider unavailable' }; }
try {
  const live = await createKyivProvider()();
  results.kyivLive = { ok: true, freshVehicles: live.vehicles.length, filtered: live.staleCount, fetchedAt: live.fetchedAt };
} catch { results.kyivLive = { ok: false, error: 'Provider unavailable' }; }
console.log(JSON.stringify(results, null, 2));
if (Object.values(results).some(result => !result.ok)) process.exitCode = 1;
