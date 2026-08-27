// Please install OpenAI SDK first: `npm install openai`
import OpenAI from "openai";

// Get a free API key at https://console.groq.com/keys
// then set it as an env var instead of hardcoding it:
//   PowerShell: $env:GROQ_API_KEY = "your-key-here"
const openai = new OpenAI({
        baseURL: '',
        apiKey: "",
});

async function main() {
  const systemMessage = { role: "system", content: `ROLE
You are a packaging-industry market research analyst working for Sequoia Print, an Indian
folding-carton and rigid-box manufacturer. You produce sourced, honest market intelligence —
never fabricated statistics.

TASK
Generate a demand-mapping report that connects three axes:
  1. Industry / vertical (e.g. Beauty & Personal Care, Food & Beverage, Jewellery, Nutraceuticals,
     Agarbatti/Incense, Gifting/Chocolates, E-commerce/Retail, Board Games, Hospitality)
  2. Packaging / print product type, restricted to this catalog:
     - Folding Carton
     - Square Box Folding Carton
     - Folding Carton Flip Box
     - Neutraceutical Box
     - Rigid Box
     - Display Box
     - Board Game Box
     - Pillow Box
     - Custom Box Dividers
     - Custom Box Inserts
     - Agarbatti Box
     - Supplement Box Mockup
     - Tray & Sleeve Box
     - Tissue Box
     - Hinged Rigid Box
     - Shoulder Neck Box
     - Lift-Off Rigid Box
     - Telescope Rigid Box
  3. Indian state / city cluster to target for outreach or R&D partnership

Limit the report to at most 8 Industry × State records — pick the highest-priority combinations
for outreach this quarter. Do not attempt to fill an exhaustive matrix of every industry against
every state.

For each Industry × State combination, provide the best-fit packaging type(s) from the catalog
above and a quantitative metric if — and only if — one exists in a credible public source
(government data, industry association report, or a named market-research firm).

METRIC RULES
- Every number must carry: (a) what it actually measures — production share, funding share,
  market share, CAGR, deal count, etc. — and (b) its source name and approximate publication date.
- Never present two metrics of different types (e.g. a funding % and a production %) as if
  they are directly comparable.
- If no credible public number exists for a cell, write "no public figure available" — do not
  estimate, round from unrelated data, or infer a percentage.
- Prefer the most recent data (last 24 months). Note the data's as-of date.

RESEARCH METHOD
- Search for state-wise DPIIT/PIB startup registration data.
- Search for D2C/consumer startup funding by city (Inc42, Forbes India, YourStory, Avendus, Tracxn).
- Search for sector-specific manufacturing-cluster data (GJEPC for jewellery, AIAMA/industry
  bodies for agarbatti, IMARC/Mordor Intelligence for nutraceuticals and carton/rigid-box
  packaging market sizing).
- Cross-check any surprising or round-number statistic against a second source before including it.

OUTPUT FORMAT
Return a single JSON object strictly matching the schema below. No commentary outside the JSON.
No markdown fences other than the one wrapping the JSON block.

JSON SCHEMA
{
  "report_metadata": {
    "title": string,
    "prepared_for": string,
    "generated_at": ISO-8601 date string,
    "disclaimer": string   // must state that metrics are not mutually comparable and are
                            // directional, not audited
  },
  "records": [
    {
      "industry": string,
      "packaging_types": [string, ...],       // must be from the catalog list above
      "state": string,
      "cluster_cities": [string, ...],        // optional, e.g. ["Rajkot","Morbi","Surat"]
      "metric": {
        "type": "production_share" | "funding_share" | "market_share" | "cagr" |
                 "deal_count" | "funding_amount" | "no_public_figure",
        "value": number | null,
        "unit": "percent" | "percent_cagr" | "usd_bn" | "count" | null,
        "as_of": string,          // e.g. "2025-Q4" or "2026"
        "description": string,    // plain-language explanation of what the number measures
        "source": string          // publisher name, e.g. "Inc42 Datalabs D2C 3.0 Report 2026"
      },
      "confidence": "high" | "medium" | "low",
      "notes": string | null
    }
  ],
  "data_gaps": [string, ...],
  "sources": [string, ...]
}

CONSTRAINTS
- Do not invent company names, deal values, or percentages under any circumstance.
- If asked to fill every cell of a matrix and data doesn't exist for some, leave those records
  with metric.type = "no_public_figure" rather than omitting the row silently.
- Keep all descriptions and notes free of hype language ("explosive growth", "massive opportunity")
  — state the number and let it speak.` };

  // This Groq project is on the free tier: 8,000 tokens/minute (TPM), counted as
  // prompt + completion combined, and enforced per-request up front — a 413 if that
  // single request's (prompt + max_completion_tokens) alone exceeds 8,000, independent
  // of anything else. The system prompt alone is ~1,050 tokens (~4,200 chars / 4).
  // Crucially: if a continuation request re-sends the *entire* prior (truncated) reply
  // as context, the prompt itself balloons past the 8,000 ceiling and every retry 413s
  // forever, no matter how long you wait. So continuations must only re-send a short
  // tail of prior output, not the whole thing — keeping every request's prompt small
  // and constant-size regardless of how much has already been generated.
  const MAX_COMPLETION_TOKENS = 6000;
  const TPM_COOLDOWN_MS = 65_000; // wait out the per-minute window before retrying/continuing
  const CONTINUATION_TAIL_CHARS = 400; // just enough for the model to see the exact cutoff point

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function requestCompletion(messages) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await openai.chat.completions.create({
          messages,
          model: "openai/gpt-oss-120b",
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          stream: false,
        });
      } catch (err) {
        const isRateLimit = err?.status === 429 || err?.status === 413 || err?.code === "rate_limit_exceeded";
        if (isRateLimit && attempt < 3) {
          console.error(`[server.js] Hit TPM rate limit (attempt ${attempt}): ${err.message}. Waiting ${TPM_COOLDOWN_MS / 1000}s for the window to reset...`);
          await sleep(TPM_COOLDOWN_MS);
          continue;
        }
        throw err;
      }
    }
  }

  let fullContent = "";
  let finishReason = "length";
  let attempts = 0;
  const maxAttempts = 5;

  while (finishReason === "length" && attempts < maxAttempts) {
    attempts++;

    // First attempt gets the real system prompt only. Continuations use the same
    // system prompt plus just a short tail of what's been generated so far — never
    // the full accumulated content — so the request stays a fixed, small size.
    const messages = attempts === 1
      ? [systemMessage]
      : [
          systemMessage,
          { role: "assistant", content: fullContent.slice(-CONTINUATION_TAIL_CHARS) },
          {
            role: "user",
            content: "Your previous reply was cut off partway through the JSON. The assistant message above is just the tail end of what you already generated. Continue the JSON output exactly where that fragment leaves off — do not repeat it, do not restart the object, and do not add commentary. Resume mid-token if needed so that concatenating everything together forms one valid JSON document.",
          },
        ];

    const completion = await requestCompletion(messages);
    const choice = completion.choices[0];
    fullContent += choice.message.content;
    finishReason = choice.finish_reason;

    if (finishReason === "length") {
      console.error(`[server.js] Response truncated (finish_reason: length) after attempt ${attempts}. Waiting for the TPM window to reset before continuing...`);
      await sleep(TPM_COOLDOWN_MS);
    }
  }

  if (finishReason === "length") {
    console.error(`[server.js] Still truncated after ${maxAttempts} attempts — output below may be incomplete.`);
  }

  console.log(fullContent);
}

main().catch((err) => {
  console.error("[server.js] Fatal error:", err?.message ?? err);
  process.exit(1);
});