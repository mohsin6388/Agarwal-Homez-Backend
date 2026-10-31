// const logger = require("../../utils/logger");
// const ApiError = require("../../utils/ApiError");

// const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// /*
//  * Keep AI replies reasonably short for faster generation.
//  * Can be overridden from environment if needed.
//  */
// const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 512);

// /*
//  * Gemini temporary failure retry configuration.
//  *
//  * Total attempts:
//  *   Attempt 1 -> normal request
//  *   Attempt 2 -> after 1 second
//  *   Attempt 3 -> after 2 seconds
//  *
//  * IMPORTANT:
//  * There is intentionally NO request timeout here.
//  * Gemini is allowed to take as much time as it needs.
//  */
// const MAX_RETRIES = 2;

// const RETRY_DELAYS_MS = [1000, 2000];

// /*
//  * HTTP statuses where retrying makes sense.
//  *
//  * 429 = rate limit
//  * 500 = internal server error
//  * 502 = bad gateway
//  * 503 = service unavailable
//  * 504 = gateway timeout
//  */
// const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// /**
//  * Returns true if a Gemini HTTP response should be retried.
//  */
// function isRetryableStatus(status) {
//   return RETRYABLE_STATUS_CODES.has(status);
// }

// /**
//  * Wait helper.
//  */
// function sleep(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// /**
//  * Calls Gemini's generateContent endpoint and returns
//  * the model's raw text.
//  *
//  * Flow:
//  *
//  * conversationEngine
//  *       ↓
//  * generateStructured
//  *       ↓
//  * generateContent
//  *       ↓
//  * Gemini
//  *       ↓
//  * JSON response
//  *
//  * Retry behavior:
//  *
//  * Attempt 1
//  *    ↓ temporary error
//  * wait 1 sec
//  *    ↓
//  * Attempt 2
//  *    ↓ temporary error
//  * wait 2 sec
//  *    ↓
//  * Attempt 3
//  *    ↓
//  * success OR final error
//  *
//  * There is NO artificial timeout.
//  *
//  * @param {Object} opts
//  * @param {string} opts.apiKey
//  * @param {string} opts.systemInstruction
//  * @param {Array<{role: 'user'|'model', text: string}>} opts.history
//  * @param {Object} [opts.responseSchema]
//  * @param {number} [opts.temperature]
//  */
// async function generateContent({
//   apiKey,
//   systemInstruction,
//   history = [],
//   responseSchema,
//   temperature = 0.8,
// }) {
//   if (!apiKey) {
//     throw ApiError.badRequest(
//       "No Gemini API key configured — add one in Settings before enabling AI conversations",
//     );
//   }

//   const url = `${API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

//   /*
//    * Keep only valid conversation turns.
//    *
//    * This does NOT change the conversation flow.
//    * It simply prevents empty/invalid history items
//    * from being sent to Gemini.
//    */
//   const contents = Array.isArray(history)
//     ? history
//         .filter(
//           (turn) =>
//             turn &&
//             (turn.role === "user" || turn.role === "model") &&
//             typeof turn.text === "string" &&
//             turn.text.trim().length > 0,
//         )
//         .map((turn) => ({
//           role: turn.role,
//           parts: [{ text: turn.text }],
//         }))
//     : [];

//   const body = {
//     system_instruction: {
//       parts: [{ text: systemInstruction || "" }],
//     },

//     contents,

//     /*
//      * Keep only ONE generationConfig.
//      *
//      * 512 tokens is enough for our structured WhatsApp response
//      * in the current flow and reduces unnecessary generation.
//      */
//     generationConfig: {
//       temperature,
//       maxOutputTokens: MAX_OUTPUT_TOKENS,

//       ...(responseSchema
//         ? {
//             responseMimeType: "application/json",
//             responseJsonSchema: responseSchema,
//           }
//         : {}),
//     },
//   };

//   /*
//    * ---------------------------------------------------------
//    * GEMINI REQUEST + RETRIES
//    * ---------------------------------------------------------
//    */

//   let lastError = null;

//   for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
//     const attemptNumber = attempt + 1;
//     const startedAt = Date.now();

//     /*
//      * If this is a retry, wait before sending the request.
//      */
//     if (attempt > 0) {
//       const delay =
//         RETRY_DELAYS_MS[attempt - 1] ||
//         RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

//       logger.warn("[gemini] Retrying Gemini request", {
//         attempt: attemptNumber,
//         maxAttempts: MAX_RETRIES + 1,
//         delayMs: delay,
//         model: DEFAULT_MODEL,
//       });

//       await sleep(delay);
//     }

//     let response;

//     try {
//       logger.info("[gemini] Sending request", {
//         attempt: attemptNumber,
//         maxAttempts: MAX_RETRIES + 1,
//         model: DEFAULT_MODEL,
//       });

//       /*
//        * IMPORTANT:
//        *
//        * NO AbortSignal.timeout() here.
//        *
//        * Gemini can take as much time as it needs.
//        */
//       response = await fetch(url, {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify(body),
//       });
//     } catch (err) {
//       const duration = Date.now() - startedAt;

//       lastError = err;

//       logger.error("[gemini] Request failed", {
//         attempt: attemptNumber,
//         maxAttempts: MAX_RETRIES + 1,
//         duration: `${duration}ms`,
//         error: err.message,
//         name: err.name,
//         model: DEFAULT_MODEL,
//       });

//       /*
//        * Network/fetch errors are considered temporary.
//        *
//        * Retry if attempts remain.
//        */
//       if (attempt < MAX_RETRIES) {
//         continue;
//       }

//       throw ApiError.internal(
//         "Failed to reach Gemini API after multiple attempts",
//       );
//     }

//     const duration = Date.now() - startedAt;

//     logger.info("[gemini] API response received", {
//       attempt: attemptNumber,
//       maxAttempts: MAX_RETRIES + 1,
//       duration: `${duration}ms`,
//       status: response.status,
//       model: DEFAULT_MODEL,
//     });

//     /*
//      * ---------------------------------------------------------
//      * SUCCESS
//      * ---------------------------------------------------------
//      */

//     if (response.ok) {
//       let data;

//       try {
//         data = await response.json();
//       } catch (err) {
//         logger.error("[gemini] Failed to parse Gemini response JSON", {
//           attempt: attemptNumber,
//           duration: `${Date.now() - startedAt}ms`,
//           error: err.message,
//         });

//         /*
//          * Invalid JSON from a successful HTTP response is
//          * generally not something we should blindly retry.
//          */
//         throw ApiError.internal("Invalid response received from Gemini");
//       }

//       const text =
//         data?.candidates?.[0]?.content?.parts
//           ?.map((part) => part?.text || "")
//           .join("") || "";

//       if (!text) {
//         const blockReason = data?.promptFeedback?.blockReason;

//         logger.warn("[gemini] Empty response from Gemini", {
//           attempt: attemptNumber,
//           duration: `${Date.now() - startedAt}ms`,
//           blockReason,
//           finishReason: data?.candidates?.[0]?.finishReason,
//         });
//       }

//       logger.info("[gemini] Generation completed", {
//         attempt: attemptNumber,
//         duration: `${Date.now() - startedAt}ms`,
//         outputLength: text.length,
//         model: DEFAULT_MODEL,
//       });

//       return {
//         text,
//         raw: data,
//       };
//     }

//     /*
//      * ---------------------------------------------------------
//      * GEMINI HTTP ERROR
//      * ---------------------------------------------------------
//      */

//     const errText = await response.text().catch(() => "");

//     const retryable = isRetryableStatus(response.status);

//     logger.error("[gemini] Gemini API returned an error", {
//       attempt: attemptNumber,
//       maxAttempts: MAX_RETRIES + 1,
//       duration: `${Date.now() - startedAt}ms`,
//       status: response.status,
//       retryable,
//       body: errText,
//       model: DEFAULT_MODEL,
//     });

//     /*
//      * Retry only temporary errors.
//      *
//      * Example:
//      * 503 -> retry
//      * 429 -> retry
//      * 500 -> retry
//      *
//      * But:
//      * 400 -> don't retry
//      * 401 -> don't retry
//      * 403 -> don't retry
//      */
//     if (retryable && attempt < MAX_RETRIES) {
//       continue;
//     }

//     /*
//      * Final failure.
//      */
//     throw ApiError.internal(`Gemini API error (${response.status})`);
//   }

//   /*
//    * This should theoretically never be reached because
//    * the loop either returns or throws.
//    */
//   throw ApiError.internal(
//     lastError?.message || "Gemini request failed after multiple attempts",
//   );
// }

// /**
//  * Convenience wrapper:
//  * Calls generateContent with a JSON schema
//  * and parses the result.
//  */
// async function generateStructured({
//   apiKey,
//   systemInstruction,
//   history,
//   responseSchema,
//   temperature,
// }) {
//   const { text, raw } = await generateContent({
//     apiKey,
//     systemInstruction,
//     history,
//     responseSchema,
//     temperature,
//   });

//   try {
//     return {
//       parsed: JSON.parse(text),
//       raw,
//     };
//   } catch (err) {
//     logger.error("[gemini] Failed to parse structured JSON response", {
//       text: text.slice(0, 500),
//       error: err.message,
//     });

//     throw ApiError.internal("AI returned an unparseable response");
//   }
// }

// module.exports = {
//   generateContent,
//   generateStructured,
//   DEFAULT_MODEL,
// };

// This below code is based on multiple gemini model swiping

const logger = require("../../utils/logger");
const ApiError = require("../../utils/ApiError");

/*
 * ---------------------------------------------------------
 * CONFIG (sab .env se override ho sakta hai)
 * ---------------------------------------------------------
 *
 * GEMINI_MODEL            -> primary model
 * GEMINI_FALLBACK_MODELS  -> comma separated backup models
 *                            (primary 503 de to yeh try honge)
 * GEMINI_MAX_OUTPUT_TOKENS-> reply ki max length
 * GEMINI_TIMEOUT_MS       -> ek request ka max time (0 = no timeout)
 */
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

const FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS || "gemini-3.1-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Duplicate hata do, order same rakho: primary pehle, phir fallbacks
const MODEL_CHAIN = [...new Set([PRIMARY_MODEL, ...FALLBACK_MODELS])];

const DEFAULT_MODEL = PRIMARY_MODEL; // purane imports ke liye

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// 512 kam tha: naye Gemini models "thinking" me bhi tokens kharch karte hain,
// jisse JSON beech me kat sakta hai. Isliye default 2048.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);

const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 40000);

/*
 * Har model par kitni baar try karna hai (pehli try + retries).
 * Delay: ~1s, ~2s, ~4s (+ random jitter taaki sab requests ek saath na takraein)
 */
const ATTEMPTS_PER_MODEL = 2;
const BASE_DELAY_MS = 1000;

// In HTTP status par retry karna sahi hai
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// In par retry ya fallback bekaar hai, seedha error do (key galat / permission nahi)
const FATAL_STATUS_CODES = new Set([401, 403]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(retryIndex) {
  const exp = BASE_DELAY_MS * 2 ** retryIndex; // 1000, 2000, 4000
  const jitter = Math.floor(Math.random() * 400);
  return exp + jitter;
}

/*
 * Ek model par ek request bhejta hai.
 * Return: { ok: true, text, raw }  ya  { ok: false, status, retryable, fatal, reason }
 */
async function callModelOnce({ model, apiKey, body }) {
  const url = `${API_BASE}/${model}:generateContent`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key URL me nahi, header me bhejo (logs me leak nahi hoti)
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      ...(REQUEST_TIMEOUT_MS > 0
        ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
        : {}),
    });
  } catch (err) {
    // Network error / timeout -> temporary maan lo
    return {
      ok: false,
      status: 0,
      retryable: true,
      fatal: false,
      reason: `${err.name}: ${err.message}`,
    };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      retryable: RETRYABLE_STATUS_CODES.has(response.status),
      fatal: FATAL_STATUS_CODES.has(response.status),
      reason: errText.slice(0, 500),
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      ok: false,
      status: response.status,
      retryable: true,
      fatal: false,
      reason: `Invalid JSON from Gemini: ${err.message}`,
    };
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || "";

  // Khali reply (safety block / MAX_TOKENS / glitch) -> dobara try karo
  if (!text.trim()) {
    return {
      ok: false,
      status: response.status,
      retryable: true,
      fatal: false,
      reason: `Empty response (blockReason=${data?.promptFeedback?.blockReason || "none"}, finishReason=${data?.candidates?.[0]?.finishReason || "none"})`,
    };
  }

  return { ok: true, text, raw: data };
}

/**
 * Gemini ko call karta hai aur model ka raw text return karta hai.
 *
 * Flow:
 *   Model 1 -> 3 tries (backoff ke saath)
 *      | fail (503 etc.)
 *   Model 2 -> 3 tries
 *      | fail
 *   Error throw (conversationEngine fallback message bhejega)
 */
async function generateContent({
  apiKey,
  systemInstruction,
  history = [],
  responseSchema,
  temperature = 0.8,
}) {
  if (!apiKey) {
    throw ApiError.badRequest(
      "No Gemini API key configured — add one in Settings before enabling AI conversations",
    );
  }

  const contents = Array.isArray(history)
    ? history
        .filter(
          (turn) =>
            turn &&
            (turn.role === "user" || turn.role === "model") &&
            typeof turn.text === "string" &&
            turn.text.trim().length > 0,
        )
        .map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.text }],
        }))
    : [];

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction || "" }],
    },
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(responseSchema
        ? {
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
          }
        : {}),
    },
  };

  let lastFailure = null;

  for (let m = 0; m < MODEL_CHAIN.length; m++) {
    const model = MODEL_CHAIN[m];

    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1);
        logger.warn("[gemini] Retrying", {
          model,
          attempt: attempt + 1,
          maxAttempts: ATTEMPTS_PER_MODEL,
          delayMs: delay,
        });
        await sleep(delay);
      }

      const startedAt = Date.now();
      const result = await callModelOnce({ model, apiKey, body });
      const duration = `${Date.now() - startedAt}ms`;

      if (result.ok) {
        logger.info("[gemini] Generation completed", {
          model,
          attempt: attempt + 1,
          duration,
          usedFallbackModel: m > 0,
          outputLength: result.text.length,
        });
        return { text: result.text, raw: result.raw };
      }

      lastFailure = result;

      logger.error("[gemini] Request failed", {
        model,
        attempt: attempt + 1,
        maxAttempts: ATTEMPTS_PER_MODEL,
        duration,
        status: result.status,
        retryable: result.retryable,
        reason: result.reason,
      });

      // Key galat / permission nahi -> aage koi model kaam nahi karega
      if (result.fatal) {
        throw ApiError.internal(`Gemini API error (${result.status})`);
      }

      // Temporary error nahi hai (400 / 404 etc.) -> is model par retry bekaar,
      // seedha next model try karo
      if (!result.retryable) break;
    }

    if (m < MODEL_CHAIN.length - 1) {
      logger.warn("[gemini] Switching to fallback model", {
        from: model,
        to: MODEL_CHAIN[m + 1],
      });
    }
  }

  throw ApiError.internal(
    `Gemini unavailable after trying ${MODEL_CHAIN.join(", ")} (last status: ${lastFailure?.status ?? "n/a"})`,
  );
}

/**
 * JSON schema ke saath call karke parsed object deta hai.
 * Agar JSON kharab aaya to ek baar dobara generate karta hai.
 */
async function generateStructured({
  apiKey,
  systemInstruction,
  history,
  responseSchema,
  temperature,
}) {
  let lastErr = null;

  for (let parseAttempt = 0; parseAttempt < 2; parseAttempt++) {
    const { text, raw } = await generateContent({
      apiKey,
      systemInstruction,
      history,
      responseSchema,
      temperature,
    });

    try {
      return { parsed: JSON.parse(text), raw };
    } catch (err) {
      lastErr = err;
      logger.error("[gemini] Failed to parse structured JSON response", {
        attempt: parseAttempt + 1,
        text: text.slice(0, 500),
        error: err.message,
      });
    }
  }

  throw ApiError.internal(
    `AI returned an unparseable response (${lastErr?.message || "unknown"})`,
  );
}

module.exports = {
  generateContent,
  generateStructured,
  DEFAULT_MODEL,
  MODEL_CHAIN,
};
