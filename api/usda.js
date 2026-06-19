// DevFit — USDA FoodData Central proxy (Vercel serverless function).
//
// Why this exists: the USDA API key must NOT ship in client JS (anyone can view
// source, steal it, and burn the rate limit). This function holds the key
// server-side. Set it once in the Vercel dashboard:
//   Project → Settings → Environment Variables → USDA_KEY = <your key>
// Get a free key in ~30s: https://fdc.nal.usda.gov/api-key-signup.html
//
// Until USDA_KEY is set it falls back to DEMO_KEY (works, just rate-limited),
// so food search keeps working from day one. OpenFoodFacts (client-side, no key)
// remains the primary source for branded/Malaysian products + barcodes.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.USDA_KEY || 'DEMO_KEY';
  const query = String((req.query && req.query.query) || '').slice(0, 100).trim();
  let pageSize = parseInt((req.query && req.query.pageSize) || '25', 10);
  if (!Number.isFinite(pageSize)) pageSize = 25;
  pageSize = Math.max(1, Math.min(pageSize, 50));

  if (!query) {
    res.status(200).json({ foods: [] });
    return;
  }

  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + '?api_key=' + encodeURIComponent(key)
    + '&query=' + encodeURIComponent(query)
    + '&pageSize=' + pageSize
    + '&dataType=' + encodeURIComponent('Foundation,SR Legacy,Survey (FNDDS),Branded');

  try {
    const r = await fetch(url);
    if (!r.ok) {
      // Never 500 the client — just return no USDA results so OFF/local still serve.
      res.status(200).json({ foods: [], error: 'usda ' + r.status });
      return;
    }
    const j = await r.json();
    // Food data is effectively static — let Vercel's edge cache it for a day.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ foods: Array.isArray(j.foods) ? j.foods : [] });
  } catch (e) {
    res.status(200).json({ foods: [], error: String(e && e.message || e) });
  }
}
