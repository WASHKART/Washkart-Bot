const express = require("express");
const axios = require("axios");
const path = require("path");
const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────
const TOKEN           = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = "1119391667920272";
const VERIFY_TOKEN    = "washkart_verify_123";
const ADMIN_NUMBER    = "917775066002";
const GEMINI_KEY      = process.env.GEMINI_KEY;
const GEMINI_URL      = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL    = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const DB              = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS      = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

// ── DB CORE ───────────────────────────────────────────────────────
async function dbInsert(t, d) { return (await axios.post(`${DB}/${t}`, d, { headers: SB_HEADERS })).data; }
async function dbSelect(t, f) { return (await axios.get(`${DB}/${t}?${f}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(t, f, d) { return (await axios.patch(`${DB}/${t}?${f}`, d, { headers: SB_HEADERS })).data; }
async function dbDelete(t, f) { return (await axios.delete(`${DB}/${t}?${f}`, { headers: { ...SB_HEADERS, Prefer: "" } })).data; }

// ── SESSIONS ──────────────────────────────────────────────────────
const sessions = {};
const processedMessages = new Set();

function normalizePhone(p) {
  p = p.replace(/\D/g, "");
  if (p.startsWith("91") && p.length === 12) return p;
  if (p.length === 10) return "91" + p;
  return p;
}
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "idle", booking: {}, history: [] };
  return sessions[phone];
}

// ── DATE UTILS ────────────────────────────────────────────────────
function formatDate(d) { return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getToday()    { return formatDate(new Date()); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return formatDate(d); }
function getDayAfter() { const d = new Date(); d.setDate(d.getDate() + 2); return formatDate(d); }
function isTodayThursday()    { return new Date().getDay() === 4; }
function isTomorrowThursday() { const d = new Date(); d.setDate(d.getDate() + 1); return d.getDay() === 4; }
function isThursdayStr(str) {
  if (!str) return false;
  const s = str.toLowerCase();
  if (s.includes("thursday") || s.includes("guruvar") || s.includes("veervar") ||
      s.includes("गुरुवार") || s.includes("bruhaspativar") || s.includes("bruhaspati")) return true;
  try { const d = new Date(str); if (!isNaN(d.getTime()) && d.getDay() === 4) return true; } catch {}
  return false;
}
function calcDeliveryDate(service, isExpress) {
  const hours = { iron: isExpress ? 4 : 36, laundry: isExpress ? 4 : 72, dryclean: isExpress ? 4 : 96, shoes: isExpress ? 4 : 48, mixed: isExpress ? 4 : 96 };
  const d = new Date();
  d.setHours(d.getHours() + (hours[service] || 72));
  if (d.getDay() === 4) d.setDate(d.getDate() + 1);
  return formatDate(d);
}
function genOrderId() { return `FW-${Date.now().toString().slice(-4)}${Math.floor(100 + Math.random() * 900)}`; }

// ── TEXT HELPERS ──────────────────────────────────────────────────
function norm(t) { return t.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " "); }
function has(t, ...words) { return words.some(w => t.includes(w)); }

// ── KEYWORD GROUPS ────────────────────────────────────────────────
// Each group covers English / Hindi / Marathi / Hinglish variations

const BOOKING_KW = [
  // ── English ──
  "pickup", "pick up", "book", "schedule", "collect", "collection",
  "booking", "place order", "new order", "want pickup", "need pickup",
  "arrange pickup", "send pickup", "get pickup", "laundry pickup",
  // ── Hindi ──
  "kapde dene", "kapde lene", "kapde bhejo", "kapde uthao", "kapde lo",
  "ghar se lelo", "ghar se lo", "ghar aao", "ghar pe aao", "aa jao",
  "pickup karna", "pickup chahiye", "pickup karo", "pickup book karo",
  "pickup lagao", "pickup bhejo", "pickup de do", "mujhe pickup",
  "book karo", "book karna", "booking karo", "booking chahiye",
  "order karo", "order dena", "order lagao", "order book karo",
  "laundry dena", "laundry lena", "laundry bhejo", "laundry chahiye",
  "kapda dena", "kapda lena", "kapde nikalo", "kapde pack karo",
  "dhobi", "dhobi bhejo", "dhobi ko bulao", "dhulai karo",
  "istri karo", "press karo", "dhona hai", "kapde dhone hain",
  // ── Marathi (romanised) ──
  "pickup hava", "pickup kara", "pickup pathva", "pickup dyaa",
  "kapde nyaa", "kapde ghya", "kapde patha", "kapde pathva",
  "kapde uthva", "kapde uthvayche", "kapde dyayche",
  "ghari ya", "ghari yaa", "ghari ya na", "ghari yeva",
  "booking kara", "book kara", "order kara", "order dyaa",
  "laundry dyaa", "laundry patha", "laundry havi", "laundry kara",
  "dhobi patha", "kapde dho", "kapde istri kara",
  "nyayala ya", "ghyayala ya", "uthayla ya", "collect kara",
  // ── Marathi (Devanagari) ──
  "पिकअप", "कपडे न्या", "कपडे घ्या", "कपडे पाठवा", "बुकिंग करा",
  "लॉन्ड्री द्या", "घरी या", "उचला", "कपडे उचला",
  // ── Hinglish ──
  "pickup book karna hai", "pickup chahiye mujhe", "bhai pickup karo",
  "yaar pickup lo", "pickup le lo", "aake lo", "aake kapde lo",
  "kapde collect karo", "kapde le jao", "kapde utha lo",
  "booking chahiye bhai", "ek booking karo", "booking de do",
  "laundry ka pickup", "wash karna hai", "dry clean karna hai",
  "parso", "parso subah", "parso shaam",
];

const TRACK_KW = [
  // ── English ──
  "track", "tracking", "order status", "check order", "order track",
  "where is my order", "status", "delivery status", "order update",
  "check status", "order info", "where are my clothes",
  // ── Hindi ──
  "kahan hai", "kab aayega", "kab milega", "kab aayenge",
  "delivery kab", "order kahan", "kapda kahan", "kapde kahan hain",
  "mera order", "mera kapda", "order check", "order dekho",
  "status check", "status batao", "kab tak aayega", "kitna time",
  "order hua kya", "pickup hua kya", "kapde aaye kya",
  "update do", "kya hua order ka", "order ka kya hua",
  // ── Marathi (romanised) ──
  "order kuth aahe", "kapde kuth aahet", "kev aayil", "kev yenar",
  "status sanga", "kiti vel lagel", "delivery kev honar",
  "kapde aale ka", "order update sanga", "kath aahe maza order",
  // ── Marathi (Devanagari) ──
  "ऑर्डर कुठे आहे", "कपडे कुठे आहेत", "स्टेटस सांगा",
  // ── Hinglish ──
  "bhai order kahan hai", "yaar status kya hai", "order track karo",
  "mujhe batao order kahan hai", "kapde kab aayenge bhai",
];

const CANCEL_KW = [
  // ── English ──
  "cancel", "cancellation", "cancel order", "cancel booking",
  "don't want", "dont want", "stop", "drop it", "nevermind",
  // ── Hindi ──
  "band karo", "nahi chahiye", "cancel karo", "booking cancel",
  "order cancel", "raddh", "cancel karna", "booking band",
  "mat karo", "rehne do", "chodo", "chhodo", "band kar do",
  "order band karo", "cancel kar do", "booking cancel karo",
  "nahi lena", "nahi dena", "nahi karwana", "rokho",
  // ── Marathi (romanised) ──
  "cancel kara", "nako", "nako aahe", "radhd kara", "thamba",
  "booking nako", "order nako", "cancel dyaa", "band kara",
  // ── Marathi (Devanagari) ──
  "रद्द करा", "नको", "बंद करा", "कॅन्सल करा",
  // ── Hinglish ──
  "yaar cancel karo", "bhai cancel kar do", "cancel bhai",
  "nahi chahiye bhai", "rehne de yaar",
];

const EXPRESS_KW = [
  // ── English ──
  "express", "urgent", "fast", "quick", "asap", "rush",
  "same day", "today delivery", "4 hour", "emergency",
  "as soon as possible", "immediately", "right now delivery",
  // ── Hindi ──
  "jaldi", "jaldi karo", "jaldi chahiye", "urgent hai",
  "express chahiye", "abhi chahiye", "aaj chahiye",
  "jaldi deliver karo", "jaldi bhejo", "urgent pickup",
  "kal tak chahiye", "aaj raat tak", "kuch ghante mein",
  // ── Marathi (romanised) ──
  "lavkar", "lavkar kara", "lavkar hava", "lavkar pathva",
  "urgent aahe", "express hava", "aaj hava", "tvarit",
  // ── Marathi (Devanagari) ──
  "लवकर", "तातडीने", "अर्जंट",
  // ── Hinglish ──
  "bhai jaldi karo", "yaar urgent hai", "express lagao",
  "jaldi bhai", "fast kar do", "express wala",
];

const HELP_KW = [
  // ── English ──
  "help", "menu", "options", "what can you do", "what can",
  "commands", "guide", "services", "how does it work",
  "how to use", "what do you offer", "info",
  // ── Hindi ──
  "kya kar sakte", "kya karte ho", "kya kya hota hai",
  "kaise use kare", "samjhao", "batao", "kya services hain",
  "madad chahiye", "madad karo", "help chahiye",
  // ── Marathi (romanised) ──
  "kay karta", "help kara", "madat kara", "kay suvidha aahe",
  "kasa vaparawa", "sangaa", "mahiti dya",
  // ── Marathi (Devanagari) ──
  "मदत", "माहिती द्या", "काय सेवा आहे",
  // ── Hinglish ──
  "bhai kya kya karte ho", "yaar help karo", "kuch samjha do",
];

const YES_KW = [
  // ── English ──
  "yes", "yep", "yup", "yeah", "sure", "correct", "confirm",
  "confirmed", "alright", "absolutely", "definitely", "proceed",
  "go ahead", "done", "ok", "okay",
  // ── Hindi ──
  "haan", "ha", "haa", "ji", "ji haan", "haan ji", "ha ji",
  "theek", "theek hai", "theek hai ji", "sahi", "sahi hai",
  "bilkul", "zaroor", "ho ja", "kar do", "haan kar do",
  "manzoor", "agree", "chalo", "chalega",
  // ── Marathi (romanised) ──
  "ho", "hoy", "hoo", "hoy na", "chalu kara", "kara",
  "theek aahe", "barobar", "accord", "nakkicha",
  // ── Marathi (Devanagari) ──
  "हो", "होय", "बरोबर", "नक्की",
  // ── Hinglish ──
  "haan bhai", "ha yaar", "ok bhai", "done bhai", "chal kar do",
];

const NO_KW = [
  // ── English ──
  "no", "nope", "nah", "not now", "later", "not yet",
  // ── Hindi ──
  "nahi", "na", "nhi", "nahin", "nai", "naa",
  "abhi nahi", "baad mein", "rehne do", "mat karo",
  "nahi chahiye", "nahi karna", "chhod do",
  // ── Marathi (romanised) ──
  "nako", "nahi", "nakos", "nahi hav", "pudhe",
  // ── Marathi (Devanagari) ──
  "नको", "नाही",
  // ── Hinglish ──
  "nahi bhai", "na yaar", "abhi nahi bhai", "nahi re",
];

const SAME_KW = [
  // ── English ──
  "same as last", "same as before", "same as last time",
  "repeat", "repeat order", "same order", "same booking",
  "same slot", "previous order", "last order again",
  // ── Hindi ──
  "pichli baar jaisa", "last wala", "wahi wala", "wahi time",
  "pehle wala", "pehle jaisa", "dobara wahi", "same karo",
  "wahi order", "wahi booking", "phir se wahi",
  "usi tarah", "pehle jaisi booking",
  // ── Marathi (romanised) ──
  "aaglyasarkha", "tyach sarkha", "last sarkha", "same kara",
  "toch order", "tich booking", "purvicha sarkha",
  // ── Marathi (Devanagari) ──
  "तसेच करा", "आधीसारखे",
  // ── Hinglish ──
  "bhai same karo", "yaar wahi wala", "same de do bhai",
];

// ── DIRECT KEYWORD SHORTCUTS (pre-Gemini) ─────────────────────────
const RATES_KW = [
  // ── English ──
  "rate card", "price list", "rates", "price", "pricing",
  "charges", "cost", "fee", "tariff", "how much", "how much does",
  "what is the price", "what are the charges", "rate batao",
  // ── Hindi ──
  "kitna lagta", "kitne paise", "kitna chahiye", "kitna hoga",
  "kitne mein", "rate kya hai", "price kya hai", "charge kya hai",
  "kitne ka", "kya rate", "daam kya", "daam batao",
  "rate list", "price batao", "charge batao", "cost kya hai",
  // ── Marathi (romanised) ──
  "kiti lagel", "kiti paisa", "rate kiti", "charge kiti",
  "kiti rupaye", "rate sanga", "price sanga", "kiti ahe",
  "dar kiti", "kiti paise lagtat",
  // ── Marathi (Devanagari) ──
  "किती लागेल", "दर काय", "रेट सांगा", "किती रुपये",
  // ── Hinglish ──
  "bhai kitna lagega", "yaar rate kya hai", "kitna dena padega",
  "rate de do", "price de do", "charge bata do",
];

const GREET_KW = [
  // ── English ──
  "hi", "hello", "hey", "hii", "helo", "heya", "howdy",
  "good morning", "good evening", "good afternoon", "good night",
  "good day", "sup", "wassup", "whatsup", "what's up",
  // ── Hindi ──
  "namaste", "namaskar", "pranam", "jai shri ram", "ram ram",
  "jai hind", "sat sri akal", "adaab", "salaam", "salam",
  "salaam alaikum", "assalam", "kya haal", "kaise ho",
  "sab theek", "kya chal raha", "kya haal hai",
  // ── Marathi (romanised) ──
  "namaskar", "jai maharashtra", "kasa aahe", "kase aahat",
  "kem cho", "kay chal", "majhet aahe", "bhari aahe",
  // ── Marathi (Devanagari) ──
  "नमस्कार", "नमस्ते", "कसे आहात", "जय महाराष्ट्र",
  // ── Hinglish ──
  "bhai hello", "yaar hi", "bhai kya haal", "hello bhai",
  "hi yaar", "kem cho bhai",
];

// ── STATUS CONFIG ─────────────────────────────────────────────────
const STATUS_MAP = {
  pending:        { label: "⏳ Pending pickup",   eta: "Our team will pick up within your selected slot." },
  picked:         { label: "🚗 Picked up",         eta: "Clothes picked up! Cleaning starts soon." },
  inprogress:     { label: "🫧 In Progress",       eta: "Your clothes are being cleaned carefully." },
  outfordelivery: { label: "🚚 Out for Delivery",  eta: "Your clothes are on the way!" },
  delivered:      { label: "✅ Delivered",         eta: "Thank you for choosing Washkart! 🙏" },
  cancelled:      { label: "❌ Cancelled",         eta: "This order was cancelled." },
};

// ── RATES ─────────────────────────────────────────────────────────
const RATES = {
  iron:
    "🔥 *IRONING RATES*\n━━━━━━━━━━━━━━━\n" +
    "👕 Normal — ₹10\n⚡ Urgent/Steam — ₹20\n" +
    "👔 Shirt/Pant/Kurta — ₹20\n🧣 Dupatta/Shawl — ₹40\n" +
    "🥻 Saree — ₹60\n💃 Anarkali — ₹20\n" +
    "👗 Lehenga — ₹100\n🧥 Blazer — ₹100\n" +
    "🛏 Bedsheet — ₹40\n🔄 Roll Press — ₹120\n" +
    "━━━━━━━━━━━━━━━\n⚡ Express = 1.5x | ⚠️ Varies by cloth",

  dryclean:
    "🧥 *DRY CLEAN — MEN*\n━━━━━━━━━━━━━━━\n" +
    "👔 Shirt/Trouser/Jeans — ₹70\n👘 Kurta — ₹150\n" +
    "🧶 Sweater — ₹200\n🧥 Blazer — ₹275\n" +
    "🧥 Jacket — ₹200\n👔 Suit 2pc — ₹250\n" +
    "👔 Suit 3pc — ₹350\n🥋 Leather Jacket — ₹350\n" +
    "👘 Jodhpuri/Sherwani — ₹300\n" +
    "━━━━━━━━━━━━━━━\n👗 *DRY CLEAN — WOMEN*\n━━━━━━━━━━━━━━━\n" +
    "👚 Kurti — ₹90 | Blouse — ₹70\n" +
    "🥻 Saree — ₹300 | Work — ₹400\n" +
    "🥻 Silk Saree — ₹350\n💃 Anarkali — ₹200\n" +
    "👗 Lehenga — ₹350 | Heavy — ₹450\n" +
    "👗 Dress — ₹175 | Gown — ₹300\n" +
    "━━━━━━━━━━━━━━━\n⚡ Express = 1.5x | ⚠️ Varies by cloth",

  laundry:
    "🫧 *LAUNDRY / WASHING*\n━━━━━━━━━━━━━━━\n" +
    "👕 Wash & Fold — ₹59/kg\n🧺 Wash & Iron — ₹79/kg\n" +
    "🛏 Bedsheet — ₹120/kg\n🛌 Blanket — ₹250/kg\n" +
    "🪟 Curtain — ₹300/kg\n🛋 Sofa Cover — ₹150/kg\n" +
    "🪣 Carpet — ₹300/kg\n" +
    "━━━━━━━━━━━━━━━\n📦 Min 1kg | 🚚 Free pickup >₹300\n⚡ Express = 1.5x",

  shoes:
    "👟 *SHOE CLEANING*\n━━━━━━━━━━━━━━━\n" +
    "👟 Sneakers — ₹300/pair\n👞 Leather — ₹400/pair\n" +
    "🩴 Slides — ₹200/pair\n🏃 Sports — ₹250/pair\n" +
    "━━━━━━━━━━━━━━━\n⚡ Express = 1.5x",
};

const HELP_MSG =
  "🧺 *Washkart — What I can do*\n━━━━━━━━━━━━━━━\n" +
  "📦 *Book pickup* — type 'pickup' or just tell me when\n" +
  "💰 *Rates* — type 'rates' or ask any item price\n" +
  "🔍 *Track order* — type 'track'\n" +
  "❌ *Cancel* — type 'cancel'\n" +
  "⚡ *Express* — type 'express' after pickup\n" +
  "🔄 *Repeat booking* — type 'same as last time'\n" +
  "━━━━━━━━━━━━━━━\nHindi, Marathi, English sab chalega! 😊\nClosed on *Thursdays* 🙏";

// ── ESTIMATE ENGINE ───────────────────────────────────────────────
const ITEM_PRICES = {
  shirt: { dryclean: 70, iron: 20, laundry: 79 }, pant: { dryclean: 70, iron: 20, laundry: 79 },
  trouser: { dryclean: 70, iron: 20, laundry: 79 }, jeans: { dryclean: 70, iron: 20, laundry: 79 },
  tshirt: { dryclean: 70, iron: 20, laundry: 79 }, kurta: { dryclean: 150, iron: 20, laundry: 79 },
  kurti: { dryclean: 90, iron: 20, laundry: 79 }, saree: { dryclean: 300, iron: 60, laundry: 120 },
  lehenga: { dryclean: 350, iron: 100 }, blazer: { dryclean: 275, iron: 100 },
  jacket: { dryclean: 200, iron: 100 }, sweater: { dryclean: 200, iron: 40 },
  dress: { dryclean: 175, iron: 40 }, dupatta: { dryclean: 150, iron: 40 },
  suit: { dryclean: 250, iron: 100 }, anarkali: { dryclean: 200, iron: 20 },
  sherwani: { dryclean: 300, iron: 100 }, gown: { dryclean: 300, iron: 100 },
  sneaker: { shoes: 300 }, shoe: { shoes: 300 }, slide: { shoes: 200 },
  bedsheet: { laundry: 120, iron: 40 }, blanket: { laundry: 250 }, curtain: { laundry: 300 },
};

function detectServiceNear(fullText, matchIndex, matchLength) {
  const w = fullText.toLowerCase().substring(Math.max(0, matchIndex - 30), matchIndex + matchLength + 30);
  if (/dry\s*clean|dryclean|dry-clean|\bdc\b|chemical/.test(w)) return "dryclean";
  if (/\biron\b|press|istri|steam/.test(w)) return "iron";
  if (/\bwash\b|\blaundry\b|dhulai|fold/.test(w)) return "laundry";
  if (/\bshoe|\bsneaker|\bjoote|footwear/.test(w)) return "shoes";
  return null;
}

function extractEstimateItems(rawText) {
  const itemRegex = /(\d+)\s*(sarees?|shirts?|pants?|trousers?|jeans?|kurtas?|kurtis?|suits?|dresses?|jackets?|sweaters?|lehengas?|lehnga|blazers?|dupattas?|bedsheets?|blankets?|sneakers?|shoes?|slides?|tshirts?|t-shirts?|gowns?|anarkali|sherwanis?)/gi;
  const tl = rawText.toLowerCase();
  let globalService = "dryclean";
  if (/dry\s*clean|dryclean|\bdc\b/.test(tl)) globalService = "dryclean";
  else if (/\biron\b|press|istri/.test(tl)) globalService = "iron";
  else if (/\bwash\b|\blaundry\b|dhulai/.test(tl)) globalService = "laundry";
  else if (/\bshoe|\bsneaker|\bjoote/.test(tl)) globalService = "shoes";
  const items = []; let match;
  while ((match = itemRegex.exec(rawText)) !== null) {
    const qty = parseInt(match[1]);
    const raw = match[2].toLowerCase()
      .replace(/sarees?$/, "saree").replace(/shirts?$/, "shirt").replace(/pants?$/, "pant")
      .replace(/trousers?$/, "trouser").replace(/kurtas?$/, "kurta").replace(/kurtis?$/, "kurti")
      .replace(/suits?$/, "suit").replace(/dresses?$/, "dress").replace(/jackets?$/, "jacket")
      .replace(/sweaters?$/, "sweater").replace(/lehengas?$|lehnga$/, "lehenga")
      .replace(/blazers?$/, "blazer").replace(/dupattas?$/, "dupatta")
      .replace(/bedsheets?$/, "bedsheet").replace(/blankets?$/, "blanket")
      .replace(/sneakers?$/, "sneaker").replace(/shoes?$/, "shoe").replace(/slides?$/, "slide")
      .replace(/t-shirts?$|tshirts?$/, "tshirt").replace(/gowns?$/, "gown").replace(/sherwanis?$/, "sherwani");
    const localSvc = detectServiceNear(rawText, match.index, match[0].length);
    items.push({ name: raw, qty, service: localSvc || globalService });
  }
  return items;
}

function calcEstimate(items) {
  let total = 0; const breakdown = []; const unknown = [];
  for (const item of items) {
    const key = item.name.toLowerCase().trim();
    const svc = item.service || "dryclean"; const qty = item.qty || 1;
    const priceRow = ITEM_PRICES[key] || ITEM_PRICES[key + "s"] || ITEM_PRICES[key.replace(/s$/, "")];
    const unitPrice = priceRow?.[svc];
    if (unitPrice) {
      total += unitPrice * qty;
      const lbl = svc === "dryclean" ? "Dry Clean" : svc === "iron" ? "Iron" : svc === "laundry" ? "Laundry" : "Shoe Clean";
      breakdown.push(`${qty}x ${item.name} (${lbl}) — ₹${unitPrice * qty}`);
    } else { unknown.push(`${item.qty}x ${item.name}`); }
  }
  return { total, breakdown, unknown };
}

// ── ITEM PRICE MAP ────────────────────────────────────────────────
const ITEM_MAP = [
  [["normal iron","sada iron","simple iron"],"Normal Iron",10],[["urgent iron","express iron"],"Urgent Iron",20],
  [["steam iron","bhap","steam press"],"Steam Iron",20],[["saree iron","saree press","sari iron"],"Saree Iron",60],
  [["lehenga iron","lehenga press"],"Lehenga Iron",100],[["blazer iron","blazer press","coat iron"],"Blazer Iron",100],
  [["roll press","roll iron"],"Roll Press",120],[["shirt iron","shirt press"],"Shirt Iron",20],
  [["pant iron","trouser iron","pant press"],"Pant Iron",20],[["kurta iron","kurta press","kurti iron"],"Kurta Iron",20],
  [["dupatta iron","dupatta press","shawl iron"],"Dupatta Iron",40],[["bedsheet iron","bed sheet iron"],"Bedsheet Iron",40],
  [["shirt dry","shirt clean","shirt dc"],"Shirt Dry Clean",70],[["pant dry","trouser dry","pant clean"],"Pant Dry Clean",70],
  [["jeans dry","jeans clean","jeans dc"],"Jeans Dry Clean",70],[["kurta dry","kurta clean","kurta dc"],"Kurta Dry Clean",150],
  [["kurti dry","kurti clean"],"Kurti Dry Clean",90],[["suit 2","2 piece","2pc suit"],"Suit 2pc Dry Clean",250],
  [["suit 3","3 piece","3pc suit"],"Suit 3pc Dry Clean",350],[["blazer dry","blazer clean","coat dry"],"Blazer Dry Clean",275],
  [["jacket dry","jacket clean"],"Jacket Dry Clean",200],[["leather jacket","leather coat"],"Leather Jacket Dry Clean",350],
  [["sweater dry","sweater clean","woolen dry"],"Sweater Dry Clean",200],
  [["saree dry","saree clean","saree dc","sari dry"],"Saree Dry Clean",300],
  [["saree work","work saree","designer saree","heavy saree"],"Saree Work Dry Clean",400],
  [["saree silk","silk saree","pure silk"],"Saree Silk Dry Clean",350],
  [["anarkali dry","anarkali clean"],"Anarkali Dry Clean",200],[["lehenga dry","lehenga clean","lehnga dry"],"Lehenga Dry Clean",350],
  [["lehenga heavy","heavy lehenga","bridal lehenga"],"Heavy Lehenga Dry Clean",450],
  [["dress dry","dress clean","frock dry"],"Dress Dry Clean",175],[["gown dry","gown clean","evening gown"],"Gown Dry Clean",300],
  [["dupatta dry","dupatta clean"],"Dupatta Dry Clean",150],[["blanket wash","razai wash","blanket clean"],"Blanket Wash",250],
  [["curtain wash","parda wash","curtain clean"],"Curtain Wash",300],[["sofa cover","sofa wash","sofa clean"],"Sofa Cover Wash",150],
  [["carpet wash","carpet clean"],"Carpet Wash",300],[["wash fold","fold wash","wash and fold"],"Wash & Fold",59],
  [["wash iron","washing iron","wash and iron"],"Wash & Iron",79],[["bedsheet wash","bed sheet wash","chadar wash"],"Bedsheet Wash",120],
  [["sneaker","sneakers","canvas shoe","white shoe"],"Sneakers Cleaning",300],
  [["leather shoe","formal shoe","oxford"],"Leather Shoes Cleaning",400],
  [["slide","slides","chappal clean"],"Slides Cleaning",200],[["sports shoe","running shoe","gym shoe"],"Sports Shoes Cleaning",250],
];
function smartPriceLookup(t) {
  for (const [keywords, name, price] of ITEM_MAP) {
    if (keywords.some(k => t.includes(k))) return { name, price };
  }
  return null;
}

// ── SEND HELPERS ──────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("sendMessage error:", e?.response?.data || e.message); }
}
async function sendButtons(to, body, buttons) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "interactive",
        interactive: { type: "button", body: { text: body },
          action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("sendButtons error:", e?.response?.data || e.message); }
}

// ── DB HELPERS ────────────────────────────────────────────────────
async function getCustomer(phone) {
  try { const r = await dbSelect("customers", `phone=eq.${phone}`); return r[0] || null; } catch { return null; }
}
async function saveCustomer(phone, name, address) {
  try {
    const ex = await getCustomer(phone);
    if (ex) await dbUpdate("customers", `phone=eq.${phone}`, { name, address });
    else await dbInsert("customers", { phone, name, address });
  } catch (e) { console.error("saveCustomer:", e.message); }
}
async function getActiveOrder(phone) {
  try {
    const rows = await dbSelect("bookings", `phone=eq.${phone}&status=neq.delivered&status=neq.cancelled&order=created_at.desc&limit=1`);
    return rows[0] || null;
  } catch { return null; }
}
async function getLastOrder(phone) {
  try {
    const rows = await dbSelect("bookings", `phone=eq.${phone}&order=created_at.desc&limit=5`);
    return rows.find(o => o.status !== "cancelled") || null;
  } catch { return null; }
}
async function saveRating(phone, orderId, rating, comment) {
  try { await dbInsert("ratings", { phone, order_id: orderId, rating, comment, created_at: new Date().toISOString() }); }
  catch (e) { console.error("saveRating:", e.message); }
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────
async function notifyAdmin(booking) {
  const src = booking.source ? ` [${booking.source}]` : "";
  await sendMessage(ADMIN_NUMBER,
    `🔔 *New Booking!*${src}\n\n🆔 ${booking.orderId}\n👤 ${booking.name}\n📱 +${booking.phone}\n📍 ${booking.address || "Walk-in"}\n📅 ${booking.date || "—"}\n🕐 ${booking.slot || "—"}`
  );
}
async function notifyAdminComplaint(phone, name, message) {
  await sendMessage(ADMIN_NUMBER, `⚠️ *Complaint!*\n\n👤 ${name || "Unknown"}\n📱 +${phone}\n💬 "${message}"\n\n_Please follow up._`);
}
async function notifyAdminRating(phone, name, orderId, rating, comment) {
  await sendMessage(ADMIN_NUMBER, `⭐ *New Rating*\n\n👤 ${name || phone}\n🆔 ${orderId || "unknown"}\n⭐ ${rating}/5\n💬 ${comment || "No comment"}`);
}

// ── POST-RATING UPSELL ────────────────────────────────────────────
async function sendPostRatingUpsell(phone) {
  setTimeout(async () => {
    await sendButtons(phone,
      "Agle baar pickup chahiye? 🧺",
      [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_track", title: "🔍 Track Order" }]
    );
  }, 2000);
}

// ── BOOKING HELPERS ───────────────────────────────────────────────
async function askDate(phone) {
  const buttons = [];
  if (!isTodayThursday()) buttons.push({ id: "date_today", title: "📅 Today" });
  if (!isTomorrowThursday()) buttons.push({ id: "date_tomorrow", title: "📅 Tomorrow" });
  buttons.push({ id: "date_custom", title: "📆 Other date" });
  await sendButtons(phone, "📅 Kaunse din pickup karein?\n\n_(Closed Thursdays)_", buttons);
}
async function askSlot(phone) {
  const hour = new Date().getHours();
  if (hour >= 16) { await sendMessage(phone, "Aaj ke slots bhar gaye 😊\nKal ke liye book karein!"); await askDate(phone); return; }
  const buttons = [];
  if (hour < 9) buttons.push({ id: "slot_morning", title: "🌅 10 AM – 1 PM" });
  buttons.push({ id: "slot_evening", title: "🌆 5 PM – 8 PM" });
  const note = hour >= 9 ? "Morning slot closed. Evening slot available:" : "Time slot choose karein:";
  await sendButtons(phone, `🕐 ${note}`, buttons);
}
async function askPriceCategory(phone) {
  await sendButtons(phone, "💰 Kaunsi service ke rates chahiye?",
    [{ id: "price_iron", title: "🔥 Ironing" }, { id: "price_dc", title: "🧥 Dry Clean" }, { id: "price_wash", title: "🫧 Laundry" }]
  );
  setTimeout(() => sendButtons(phone, "👇 Aur:", [{ id: "price_shoe", title: "👟 Shoe Cleaning" }, { id: "btn_book", title: "📦 Book Pickup" }]), 700);
}
async function showBookingConfirm(phone, session) {
  const bk = session.booking;
  await sendButtons(phone,
    `Got it! 👍\n\n📅 ${bk.date}\n🕐 ${bk.slot}\n📍 ${bk.address}\n\nConfirm booking?`,
    [{ id: "confirm_direct", title: "✅ Confirm" }, { id: "date_custom", title: "📆 Change date" }, { id: "update_details", title: "✏️ Change address" }]
  );
  session.step = "direct_confirm";
}
async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  booking.orderId = orderId; booking.phone = phone;
  try {
    await dbInsert("bookings", {
      order_id: orderId, name: booking.name, phone,
      address: booking.address || "", date: booking.date || "", slot: booking.slot || "",
      status: "pending", reminder_sent: false,
      source: booking.source || "whatsapp"
    });
  } catch (e) { console.error("saveBooking:", e.message); }
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n🆔 *${orderId}*\n👤 ${booking.name}\n📍 ${booking.address || "—"}\n📅 ${booking.date || "—"}\n🕐 ${booking.slot || "—"}\n\n` +
    `Our team will arrive within your slot. 💚\n💰 Payment via UPI/Cash at delivery.\n\nCancel karne ke liye: *cancel*`
  );
  await notifyAdmin(booking);
}

// ── GEMINI AI ─────────────────────────────────────────────────────
async function geminiChat(phone, userMessage, session, customer, activeOrder, lastOrder) {
  const history = (session.history || []).slice(-6);
  const systemPrompt = `You are Washkart Assistant — a friendly WhatsApp laundry bot for Washkart Laundry, Pimpri, Maharashtra.

RULES:
1. Reply in SAME language as customer (Hindi/Marathi/Hinglish/English). If they write in Marathi, reply in Marathi.
2. SHORT replies — max 3-4 lines. Friendly, use emojis
3. CLOSED on Thursdays — suggest another day
4. Never invent prices

MARATHI DATE/TIME WORDS (understand these):
- "आज" / "aaj" = today
- "उद्या" / "udya" = tomorrow
- "परवा" / "parso" / "parsoon" = day after tomorrow
- "सकाळी" / "sakali" / "sakal" = morning
- "संध्याकाळी" / "sandhyakal" / "sham" = evening
- "गुरुवार" / "guruvar" = Thursday (CLOSED)

MARATHI BOOKING WORDS (understand these as pickup intent):
"कपडे न्या", "कपडे घ्या", "घरी या", "पिकअप द्या", "बुकिंग करा", "लॉन्ड्री द्या",
"pickup hava", "kapde nyaa", "ghari ya", "booking kara", "laundry dyaa"

CUSTOMER:
- Name: ${customer?.name || "New customer"}
- Address: ${customer?.address || "Not saved"}
- Active order: ${activeOrder ? `${activeOrder.order_id} — ${STATUS_MAP[activeOrder.status]?.label}` : "None"}
- Last order: ${lastOrder ? `${lastOrder.date} | ${lastOrder.slot} | ${lastOrder.address}` : "None"}

TODAY: ${getToday()}${isTodayThursday() ? " (THURSDAY — CLOSED)" : ""}
TOMORROW: ${getTomorrow()}${isTomorrowThursday() ? " (THURSDAY — CLOSED)" : ""}
DAY AFTER: ${getDayAfter()}

BOOKING STATE:
- Name: ${session.booking?.name || "missing"}
- Address: ${session.booking?.address || "missing"}
- Date: ${session.booking?.date || "missing"}
- Slot: ${session.booking?.slot || "missing"}

RATES:
Iron: Normal ₹10, Urgent ₹20, Shirt/Pant/Kurta ₹20, Saree ₹60, Lehenga ₹100, Blazer ₹100
Dry Clean Men: Shirt/Pant/Jeans ₹70, Kurta ₹150, Suit 2pc ₹250, Suit 3pc ₹350, Blazer ₹275, Jacket ₹200, Sweater ₹200
Dry Clean Women: Saree ₹300, Saree Work ₹400, Saree Silk ₹350, Lehenga ₹350, Heavy ₹450, Kurti ₹90, Dress ₹175
Laundry: Wash & Fold ₹59/kg, Wash & Iron ₹79/kg
Shoes: Sneakers ₹300, Leather ₹400, Sports ₹250, Slides ₹200
Express: 1.5x, 4-8hrs. Free pickup above ₹300.

RESPOND with JSON only (no markdown):
{
  "reply": "your friendly reply",
  "action": "none"|"book_now"|"need_name"|"need_address"|"need_date"|"need_slot"|"show_iron"|"show_dryclean"|"show_laundry"|"show_shoes"|"show_rates_menu"|"track_order"|"complaint"|"estimate",
  "extracted": { "name": null, "address": null, "date": "today"|"tomorrow"|"day_after_tomorrow"|"date string"|null, "slot": "morning"|"evening"|null, "items": [{"name":"shirt","qty":2,"service":"dryclean"}]|null }
}

ACTION GUIDE:
- General price query (no qty) → show_iron/show_dryclean/show_laundry/show_shoes/show_rates_menu
- Specific items WITH quantities → "estimate", fill items array PER-ITEM service
- Booking intent → need_name/need_address/need_date/need_slot/book_now
- Complaint → complaint | Track → track_order | Greeting → none with friendly reply

ESTIMATE — detect service PER ITEM:
"2 shirt dryclean aur 1 saree press" → [{name:shirt,qty:2,service:dryclean},{name:saree,qty:1,service:iron}]

HISTORY:
${history.map(h => `${h.role}: ${h.text}`).join("\n")}`;

  try {
    const res = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nCustomer: "${userMessage}"` }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    });
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let clean = raw.replace(/```json|```/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) clean = m[0];
    const parsed = JSON.parse(clean);
    if (!parsed.extracted) parsed.extracted = {};
    return parsed;
  } catch (e) {
    console.error("Gemini error:", e?.response?.data || e.message);
    return { reply: "Ek second! 😊 Pickup book karein, rates dekhein, ya order track karein!", action: "none", extracted: {} };
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────
async function handleMessage(phone, rawText) {
  phone = normalizePhone(phone);
  const session = getSession(phone);
  const t = norm(rawText);

  if (!session.history) session.history = [];
  session.history.push({ role: "customer", text: rawText });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // ══ LAYER 1: Active session steps ════════════════════════════════

  if (session.step === "get_name") {
    if (rawText.trim().length < 2) { await sendMessage(phone, "Please apna naam share karein 😊"); return; }
    session.booking.name = rawText.trim();
    session.step = "idle";
    if (!session.booking.address) { session.step = "get_address"; await sendMessage(phone, `Thanks ${session.booking.name}! 😊\n\n📍 Apna pickup address bhejein:`); }
    else if (!session.booking.date) { await askDate(phone); session.step = "select_date"; }
    else if (!session.booking.slot) { await askSlot(phone); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session); }
    return;
  }

  if (session.step === "get_address") {
    if (rawText.trim().length < 3) { await sendMessage(phone, "📍 Apna complete address bhejein:"); return; }
    session.booking.address = rawText.trim();
    if (session.booking.name) await saveCustomer(phone, session.booking.name, session.booking.address);
    session.step = "idle";
    if (!session.booking.date) { await askDate(phone); session.step = "select_date"; }
    else if (!session.booking.slot) { await askSlot(phone); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session); }
    return;
  }

  if (session.step === "get_custom_date") {
    if (isThursdayStr(rawText)) { await sendMessage(phone, "Thursday ko hum band rehte hain 🙏\nKoi aur din batao:"); return; }
    session.booking.date = rawText.trim(); session.step = "idle";
    if (!session.booking.slot) { await askSlot(phone); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session); }
    return;
  }

  if (session.step === "tracking") {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings", `order_id=eq.${m[0].toUpperCase()}`).catch(() => []);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
        const del = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
        await sendMessage(phone, `🆔 *${rows[0].order_id}*\n${s.label}${del}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
      } else { await sendMessage(phone, "Order nahi mila. ID check karein 😊"); }
      session.step = "idle"; return;
    }
    await sendMessage(phone, "Valid Order ID bhejein, jaise *FW-1234* 😊"); return;
  }

  if (session.step === "confirm_cancel") {
    if (rawText.startsWith("cc_")) {
      const orderId = rawText.replace("cc_", "");
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`).catch(() => []);
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
      await sendMessage(phone, `✅ Order *${orderId}* cancel ho gaya.\nPhir se book karna ho: *pickup* 🧺`);
      if (rows[0]) await sendMessage(ADMIN_NUMBER, `❌ *Cancelled*\n🆔 ${orderId}\n👤 ${rows[0].name}\n📅 ${rows[0].date}`);
    } else if (rawText === "no_cancel") {
      await sendMessage(phone, "Theek hai! Order still active hai 👍");
    } else { await sendMessage(phone, "Cancel karna hai to 'Yes, Cancel' dabao."); return; }
    session.step = "idle"; return;
  }

  if (session.step === "direct_confirm") {
    if (rawText === "confirm_direct" || has(t, ...YES_KW)) {
      session.step = "idle";
      const bk = session.booking;
      if (bk.name && bk.address && bk.date && bk.slot) { await confirmBooking(phone, bk); session.booking = {}; }
      else { await sendMessage(phone, "Kuch details missing hain. *pickup* se dobara try karein."); }
      return;
    }
    if (rawText === "date_custom") { session.step = "get_custom_date"; await sendMessage(phone, "📅 Date type karein (e.g. *28 April*):"); return; }
    if (rawText === "update_details") { session.booking = {}; session.step = "get_address"; await sendMessage(phone, "📍 Naya address bhejein:"); return; }
    if (has(t, ...NO_KW)) { session.step = "idle"; session.booking = {}; await sendMessage(phone, "No problem! Jab ready ho: *pickup* 😊"); return; }
    await showBookingConfirm(phone, session); return;
  }

  // ── FEEDBACK STEP — button-based rating ──────────────────────────
  // FIX: Feedback step is checked early so rating button IDs are always caught,
  // regardless of how long the customer took to tap.
  if (session.step === "feedback") {
    const ratingMap = { "rating_excellent": 5, "rating_good": 4, "rating_poor": 2 };
    const lastOrder = await getLastOrder(phone);
    const customer = await getCustomer(phone);

    if (ratingMap[rawText] !== undefined) {
      const stars = ratingMap[rawText];
      await saveRating(phone, lastOrder?.order_id, stars, null);
      await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, stars, null);
      if (stars === 5) {
        await sendMessage(phone, "Shukriya! ⭐⭐⭐⭐⭐ Aapka support bahut matlab rakhta hai! 🙏\nMilte hain agli baar Washkart pe!");
        session.step = "idle";
        await sendPostRatingUpsell(phone);
      } else if (stars === 4) {
        await sendMessage(phone, "Thanks! 😊 Kuch aur better kar sakte hain? Batao — hum improve karenge!");
        session.step = "feedback_comment";
      } else {
        await sendMessage(phone, "Bahut sorry for the experience 🙏\nKya problem aayi? Batao — hum zaroor fix karenge.");
        await notifyAdminComplaint(phone, customer?.name, `Low rating (${stars}/5) from ${customer?.name || phone}`);
        session.step = "feedback_comment";
      }
      return;
    }
    // Text reply — treat as comment without star
    await saveRating(phone, lastOrder?.order_id, null, rawText);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "text", rawText);
    await sendMessage(phone, "Shukriya feedback ke liye! 🙏 Milte hain agli baar!");
    session.step = "idle";
    await sendPostRatingUpsell(phone);
    return;
  }

  if (session.step === "feedback_comment") {
    const lastOrder = await getLastOrder(phone);
    const customer = await getCustomer(phone);
    await saveRating(phone, lastOrder?.order_id, null, rawText);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "comment", rawText);
    await sendMessage(phone, "Shukriya! 🙏 Hum aur better karenge. Milte hain agli baar!");
    session.step = "idle";
    await sendPostRatingUpsell(phone);
    return;
  }

  // ══ LAYER 2: Button IDs ══════════════════════════════════════════
  if (rawText === "price_iron")     { await sendMessage(phone, RATES.iron); return; }
  if (rawText === "price_dc")       { await sendMessage(phone, RATES.dryclean); return; }
  if (rawText === "price_wash")     { await sendMessage(phone, RATES.laundry); return; }
  if (rawText === "price_shoe")     { await sendMessage(phone, RATES.shoes); return; }
  if (rawText === "btn_price")      { await askPriceCategory(phone); return; }
  if (rawText === "btn_track")      { await handleTrack(phone, session, null); return; }
  if (rawText === "date_today")     { await handleDateButton(phone, session, "today"); return; }
  if (rawText === "date_tomorrow")  { await handleDateButton(phone, session, "tomorrow"); return; }
  if (rawText === "date_custom")    { session.step = "get_custom_date"; await sendMessage(phone, "📅 Date type karein (e.g. *28 April*):\n_(Closed Thursdays)_"); return; }
  if (rawText === "slot_morning")   { session.booking.slot = "Morning (10 AM – 1 PM)"; await handleSlotSelected(phone, session); return; }
  if (rawText === "slot_evening")   { session.booking.slot = "Evening (5 PM – 8 PM)"; await handleSlotSelected(phone, session); return; }
  if (rawText === "use_saved")      { const s = await getCustomer(phone); if (s) { session.booking.name = s.name; session.booking.address = s.address; } await askDate(phone); session.step = "select_date"; return; }
  if (rawText === "update_details") { session.booking = {}; session.step = "get_address"; await sendMessage(phone, "📍 Naya address bhejein:"); return; }
  if (rawText === "no_cancel")      { await sendMessage(phone, "Theek hai! Order still active 👍"); return; }
  if (rawText === "confirm_direct") { if (session.step === "direct_confirm") { session.step = "idle"; await confirmBooking(phone, session.booking); session.booking = {}; } return; }
  if (rawText === "btn_book")       { session.booking = {}; }

  // ══ LAYER 3: Keyword shortcuts ════════════════════════════════════
  if (rawText === "__audio__")      { await sendMessage(phone, "Voice notes nahi sun sakta 😊 Please type karein!"); return; }
  if (has(t, ...HELP_KW))           { await sendMessage(phone, HELP_MSG); return; }
  if (has(t, ...CANCEL_KW))         { await handleCancel(phone, session, rawText); return; }
  if (has(t, ...TRACK_KW))          { await handleTrack(phone, session, rawText); return; }
  if (has(t, ...EXPRESS_KW) && session.step === "idle") { await handleExpress(phone); return; }
  if (has(t, ...SAME_KW))           { await handleSameAsLast(phone, session); return; }

  // ── DIRECT HANDLERS: Rates & Greetings (never hit Gemini) ────────
  // Greetings
  if (has(t, ...GREET_KW)) {
    const customer = await getCustomer(phone);
    const active = await getActiveOrder(phone);
    if (customer) {
      if (active) {
        await sendMessage(phone,
          `${customer.name} ji, swagat hai! 👋\n\nAapka order *${active.order_id}* — ${STATUS_MAP[active.status]?.label} 📦\n\n*track* — status | *pickup* — new booking | *rates* — prices`
        );
      } else {
        await sendButtons(phone,
          `${customer.name} ji, swagat hai! 👋\n\nKya karu aapke liye? 😊`,
          [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
        );
      }
    } else {
      await sendButtons(phone,
        "Hi! 👋 *Washkart* mein aapka swagat hai!\n\nPimpri-Chinchwad ka #1 laundry service 🧺",
        [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
      );
    }
    return;
  }

  // Rates
  if (has(t, ...RATES_KW)) {
    // Check for specific service in the message first
    if (has(t, "iron", "press", "istri")) { await sendMessage(phone, RATES.iron); return; }
    if (has(t, "dry", "dryclean", "dry clean", "dc")) { await sendMessage(phone, RATES.dryclean); return; }
    if (has(t, "wash", "laundry", "dhulai", "fold")) { await sendMessage(phone, RATES.laundry); return; }
    if (has(t, "shoe", "sneaker", "joote", "footwear")) { await sendMessage(phone, RATES.shoes); return; }
    // Generic rates request — show menu
    await askPriceCategory(phone);
    return;
  }

  // "Book pickup" exact phrase
  if (has(t, "book pickup", "pickup book")) { await handleBookingIntent(phone, session, rawText, t); return; }

  if (has(t, ...BOOKING_KW) || rawText === "btn_book") { await handleBookingIntent(phone, session, rawText, t); return; }

  // ══ LAYER 4: Gemini ══════════════════════════════════════════════
  const customer = await getCustomer(phone);
  const active = await getActiveOrder(phone);
  const lastOrder = await getLastOrder(phone);
  if (customer) {
    if (!session.booking.name) session.booking.name = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
  }

  const ai = await geminiChat(phone, rawText, session, customer, active, lastOrder);
  console.log(`[AI] action:${ai.action} reply:${ai.reply?.slice(0, 60)}`);

  if (ai.extracted?.name && !session.booking.name) session.booking.name = ai.extracted.name;
  if (ai.extracted?.address && !session.booking.address) session.booking.address = ai.extracted.address;
  if (ai.extracted?.date) {
    const d = ai.extracted.date;
    session.booking.date = d === "today" ? getToday()
      : d === "tomorrow" ? getTomorrow()
      : d === "day_after_tomorrow" ? getDayAfter()
      : d;
    if (isThursdayStr(session.booking.date)) {
      session.booking.date = null;
      await sendMessage(phone, "Thursday ko hum band rehte hain 🙏\nKoi aur din choose karein:");
      await askDate(phone); return;
    }
  }
  if (ai.extracted?.slot === "morning") session.booking.slot = "Morning (10 AM – 1 PM)";
  if (ai.extracted?.slot === "evening") session.booking.slot = "Evening (5 PM – 8 PM)";

  switch (ai.action) {
    case "book_now":
      if (active && active.status !== "cancelled") {
        await sendMessage(phone, `Active order hai *${active.order_id}* (${STATUS_MAP[active.status]?.label}).\nCancel: *cancel* | Track: *track*`); return;
      }
      if (session.booking.name && session.booking.address && session.booking.date && session.booking.slot) {
        await confirmBooking(phone, session.booking); session.booking = {};
      } else { await handleBookingIntent(phone, session, rawText, t); }
      break;
    case "need_name":    session.step = "get_name";    await sendMessage(phone, ai.reply || "Apna naam batao 😊"); break;
    case "need_address": session.step = "get_address"; await sendMessage(phone, ai.reply || "📍 Pickup address bhejein:"); break;
    case "need_date":    if (ai.reply) await sendMessage(phone, ai.reply); await askDate(phone); session.step = "select_date"; break;
    case "need_slot":    if (ai.reply) await sendMessage(phone, ai.reply); await askSlot(phone); session.step = "select_slot"; break;
    case "show_rates_menu": await askPriceCategory(phone); break;
    case "show_iron":       await sendMessage(phone, RATES.iron); break;
    case "show_dryclean":   await sendMessage(phone, RATES.dryclean); break;
    case "show_laundry":    await sendMessage(phone, RATES.laundry); break;
    case "show_shoes":      await sendMessage(phone, RATES.shoes); break;
    case "track_order":
      if (active) {
        const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
        const del = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
        await sendMessage(phone, `📦 *Aapka Order*\n\n🆔 ${active.order_id}\n${s.label}${del}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
      } else { await sendMessage(phone, ai.reply || "Koi active order nahi. *pickup* type karein 🧺"); }
      break;
    case "complaint":
      await sendMessage(phone, ai.reply || "Bahut sorry 🙏 Admin se contact ho jayega.");
      await notifyAdminComplaint(phone, customer?.name, rawText); break;
    case "estimate": {
      let items = ai.extracted?.items?.length ? ai.extracted.items : extractEstimateItems(rawText);
      if (items.length > 0) {
        const { total, breakdown, unknown } = calcEstimate(items);
        if (total > 0) {
          let msg = `💰 *Estimate*\n━━━━━━━━━━━━━━━\n`;
          breakdown.forEach(l => msg += `${l}\n`);
          if (unknown.length) msg += `\n⚠️ Estimate nahi mila: ${unknown.join(", ")}\n`;
          msg += `━━━━━━━━━━━━━━━\n*Total: ₹${total}*\n⚡ Express (4–8hr): ₹${Math.ceil(total * 1.5)}\n\n_Final bill may vary_\n\nPickup ke liye: *pickup* 🧺`;
          await sendMessage(phone, msg);
        } else { await sendMessage(phone, ai.reply || "Items aur service batao 😊"); }
      } else { await sendMessage(phone, ai.reply || "e.g. *3 shirt dry clean, 2 saree iron* 😊"); }
      break;
    }
    default:
      if (ai.reply) { await sendMessage(phone, ai.reply); }
      else if (customer) { await sendMessage(phone, `${customer.name} ji! 👋\n\n*pickup* — booking\n*rates* — prices\n*track* — order status`); }
      else { await sendButtons(phone, "Hi! 👋 Washkart mein aapka swagat hai!",
        [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]); }
  }
  if (ai.reply) session.history.push({ role: "bot", text: ai.reply });
}

// ── FLOW HELPERS ──────────────────────────────────────────────────
async function handleDateButton(phone, session, which) {
  if (which === "today") {
    if (isTodayThursday()) { await sendMessage(phone, "Aaj Thursday hai — hum band 🙏"); await askDate(phone); return; }
    session.booking.date = getToday();
  } else {
    if (isTomorrowThursday()) { await sendMessage(phone, "Kal Thursday hai — hum band 🙏"); await askDate(phone); return; }
    session.booking.date = getTomorrow();
  }
  session.step = "select_slot"; await askSlot(phone);
}
async function handleSlotSelected(phone, session) {
  session.step = "idle";
  const bk = session.booking;
  if (bk.name && bk.address && bk.date && bk.slot) { await showBookingConfirm(phone, session); }
  else if (!bk.date) { await askDate(phone); session.step = "select_date"; }
}
async function handleTrack(phone, session, rawText) {
  if (rawText) {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings", `order_id=eq.${m[0].toUpperCase()}`).catch(() => []);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
        const del = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
        await sendMessage(phone, `📦 *${rows[0].order_id}*\n${s.label}${del}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        return;
      }
    }
  }
  const active = await getActiveOrder(phone);
  if (active) {
    const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
    const del = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
    await sendMessage(phone, `📦 *Aapka Order*\n\n🆔 ${active.order_id}\n${s.label}${del}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
    return;
  }
  session.step = "tracking"; await sendMessage(phone, "🔍 Apna Order ID share karein (e.g. *FW-1234*):"); return;
}
async function handleCancel(phone, session, rawText) {
  const m = rawText.match(/FW-\d+/i);
  const active = await getActiveOrder(phone);
  const orderId = m ? m[0].toUpperCase() : active?.order_id;
  if (!orderId) { session.step = "idle"; await sendMessage(phone, "Koi active order nahi mila. *pickup* type karein 🧺"); return; }
  try {
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    if (!rows.length) { await sendMessage(phone, "Order nahi mila."); return; }
    if (["delivered", "cancelled"].includes(rows[0].status)) {
      await sendMessage(phone, `Order *${orderId}* already ${STATUS_MAP[rows[0].status]?.label} hai.`); return;
    }
    await sendButtons(phone, `Cancel karein *${orderId}*?\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`,
      [{ id: `cc_${orderId}`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ Keep it" }]
    );
    session.step = "confirm_cancel";
  } catch { await sendMessage(phone, "Kuch problem aayi. Phir try karein."); }
}
async function handleExpress(phone) {
  const active = await getActiveOrder(phone);
  if (active?.status === "picked") {
    if (isTodayThursday()) { await sendMessage(phone, "Thursday ko express nahi hai 🙏"); return; }
    await dbUpdate("bookings", `order_id=eq.${active.order_id}`, { express: true });
    await sendMessage(phone, `⚡ *Express Confirmed!*\n\n4–8 hours mein deliver! 🙌\n💰 1.5x charges at delivery.\n\n🆔 ${active.order_id}`);
    await sendMessage(ADMIN_NUMBER, `⚡ *Express!*\n🆔 ${active.order_id}\n👤 ${active.name}\n📱 +${active.phone}`);
    return;
  }
  await sendMessage(phone, "Express pickup ke baad request hota hai. Pehle *pickup* book karein 🧺");
}
async function handleSameAsLast(phone, session) {
  const customer = await getCustomer(phone);
  const last = await getLastOrder(phone);
  const active = await getActiveOrder(phone);
  if (active && active.status !== "cancelled") { await sendMessage(phone, `Order *${active.order_id}* already active hai. Pehle deliver hone do! 😊`); return; }
  if (!last) { await sendMessage(phone, "Koi purana order nahi mila. *pickup* type karein! 🧺"); return; }
  session.booking.name = customer?.name || last.name;
  session.booking.address = last.address;
  await sendButtons(phone, `Same as last time! 🔄\n\n📍 ${last.address}\n\nKis din pickup karein?`,
    [{ id: "date_today", title: "📅 Today" }, { id: "date_tomorrow", title: "📅 Tomorrow" }, { id: "date_custom", title: "📆 Other date" }]
  );
  session.step = "select_date";
}
async function handleBookingIntent(phone, session, rawText, t) {
  const customer = await getCustomer(phone);
  const active = await getActiveOrder(phone);
  if (active && active.status !== "cancelled") {
    await sendMessage(phone, `Order *${active.order_id}* already active (${STATUS_MAP[active.status]?.label}).\nCancel: *cancel* | Track: *track*`); return;
  }
  if (customer) {
    if (!session.booking.name) session.booking.name = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
  }
  const hasTomorrow = has(t, "kal ", "tomorrow", "kal ko", "next day", "udya", "उद्या");
  const hasToday    = has(t, "aaj ", "today", "abhi", "aaj ko", "aajach", "aज");
  const hasParso    = has(t, "parso", "परवा", "day after tomorrow", "day after", "parsoon");
  const hasMorning  = has(t, "subah", "morning", "savere", "subeh", "10 am", "11 am", "sakali", "sakal", "सकाळी", "सुबह");
  const hasEvening  = has(t, "shaam", "evening", "sham", "5 pm", "6 pm", "7 pm", "sandhyakal", "संध्याकाळी", "शाम");
  if (hasParso && !session.booking.date) {
    session.booking.date = getDayAfter();
  } else if (hasTomorrow && !session.booking.date) {
    if (isTomorrowThursday()) { await sendMessage(phone, "Kal Thursday hai — hum band 🙏\nKoi aur din?"); await askDate(phone); return; }
    session.booking.date = getTomorrow();
  } else if (hasToday && !session.booking.date) {
    if (isTodayThursday()) { await sendMessage(phone, "Aaj Thursday hai — hum band 🙏\nKoi aur din?"); await askDate(phone); return; }
    session.booking.date = getToday();
  }
  if (hasMorning && !session.booking.slot) session.booking.slot = "Morning (10 AM – 1 PM)";
  else if (hasEvening && !session.booking.slot) session.booking.slot = "Evening (5 PM – 8 PM)";
  const bk = session.booking;
  if (customer && bk.name && bk.address && bk.date && bk.slot) { await showBookingConfirm(phone, session); return; }
  if (bk.date && !bk.slot) { await askSlot(phone); session.step = "select_slot"; return; }
  if (!bk.date && bk.slot) { await askDate(phone); session.step = "select_date"; return; }
  if (customer && bk.name && bk.address) {
    await sendButtons(phone, `Pickup book karein? 😊\n\n📍 ${customer.address}`,
      [{ id: "use_saved", title: "✅ Yes, this address" }, { id: "update_details", title: "✏️ New address" }]
    );
    session.step = "confirm_details"; return;
  }
  if (!bk.name) { await sendMessage(phone, "👋 Welcome to *Washkart*! 🧺\n\nApna naam batao:"); session.step = "get_name"; return; }
  if (!bk.address) { await sendMessage(phone, `📍 ${bk.name} ji, apna pickup address bhejein:`); session.step = "get_address"; return; }
  await askDate(phone); session.step = "select_date";
}

// ── REMINDERS ─────────────────────────────────────────────────────
async function sendReminders() {
  try {
    const today = getToday();
    const rows = await dbSelect("bookings", `date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const hour = new Date().getHours();
    for (const b of rows) {
      if ((b.slot?.includes("Morning") && hour === 8) || (b.slot?.includes("Evening") && hour === 15)) {
        await sendMessage(b.phone, `⏰ *Pickup Reminder!*\n\nHi ${b.name}! Aaj Washkart pickup hai.\n\n🕐 ${b.slot}\n📍 ${b.address}\n🆔 ${b.order_id}\n\nCancel: *cancel*`);
        await dbUpdate("bookings", `order_id=eq.${b.order_id}`, { reminder_sent: true });
      }
    }
  } catch (e) { console.error("Reminder error:", e.message); }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ── WEBHOOK ───────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});
app.post("/webhook", async (req, res) => {
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return res.sendStatus(200);
    const msg = messages[0];
    if (processedMessages.has(msg.id)) return res.sendStatus(200);
    processedMessages.add(msg.id);
    setTimeout(() => processedMessages.delete(msg.id), 60000);
    const phone = normalizePhone(msg.from);
    if (msg.type === "audio") { await handleMessage(phone, "__audio__"); return res.sendStatus(200); }
    let text = "";
    if (msg.type === "text") text = msg.text.body;
    else if (msg.type === "interactive") {
      text = msg.interactive.type === "button_reply" ? msg.interactive.button_reply.id : msg.interactive.list_reply.id;
    }
    if (text) await handleMessage(phone, text);
    res.sendStatus(200);
  } catch (err) { console.error(err?.response?.data || err.message); res.sendStatus(200); }
});

// ── DASHBOARD API ─────────────────────────────────────────────────
app.get("/bookings", async (req, res) => {
  try { res.json(await dbSelect("bookings", "order=created_at.desc")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// FIX: Walk-in orders default to status=picked; address/slot/date optional
app.post("/bookings", async (req, res) => {
  try {
    const { name, phone, address, date, slot, source, notes, service_type } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });

    const isWalkIn = source === "walkin";
    // For walk-in, address/date/slot are optional; for others they're required
    if (!isWalkIn && (!address || !date || !slot)) {
      return res.status(400).json({ error: "Missing required fields: address, date, slot" });
    }

    const orderId = genOrderId();
    const normPhone = normalizePhone(phone);
    const initialStatus = isWalkIn ? "picked" : "pending";

    await dbInsert("bookings", {
      order_id: orderId,
      name,
      phone: normPhone,
      address: address || "Walk-in (In-store)",
      date: date || getToday(),
      slot: slot || "Walk-in",
      status: initialStatus,
      reminder_sent: false,
      source: source || "walkin",
      notes: notes || "",
      ...(service_type ? { service_type } : {}),
    });

    // Save/update customer (address optional for walk-in)
    if (address) {
      await saveCustomer(normPhone, name, address);
    } else {
      // Save customer without address if they don't exist yet
      const existing = await getCustomer(normPhone);
      if (!existing) await dbInsert("customers", { phone: normPhone, name, address: "" }).catch(() => {});
    }

    // Notify admin
    await sendMessage(ADMIN_NUMBER,
      `🔔 *New Booking [${source || "Walk-in"}]*\n\n🆔 ${orderId}\n👤 ${name}\n📱 +${normPhone}\n📍 ${address || "Walk-in (In-store)"}\n📅 ${date || getToday()}\n🕐 ${slot || "Walk-in"}${notes ? `\n📝 ${notes}` : ""}${service_type ? `\n🧺 ${service_type}` : ""}\n\n_Status: ${initialStatus}_`
    );

    res.json({ success: true, order_id: orderId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/bookings/:orderId", async (req, res) => {
  try {
    const { status, service_type, express, delivery_date, notes } = req.body;
    const orderId = req.params.orderId;
    const updateData = { status };
    if (service_type) updateData.service_type = service_type;
    if (express !== undefined) updateData.express = express;
    if (delivery_date) updateData.delivery_date = delivery_date;
    if (notes !== undefined) updateData.notes = notes;
    if (service_type && !delivery_date) updateData.delivery_date = calcDeliveryDate(service_type, express || false);
    await dbUpdate("bookings", `order_id=eq.${orderId}`, updateData);
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    const b = rows[0];

    // Send WhatsApp notification — NOT for cancelled
    const msgs = {
      picked:
        `🚗 *Kapde pick up ho gaye!*\n\n` +
        (b?.service_type ? `🧺 Service: ${b.service_type}\n` : "") +
        (updateData.delivery_date ? `📦 Est. Delivery: *${updateData.delivery_date}*\n` : "") +
        `\n⚡ Urgent chahiye? Reply *EXPRESS* for 4–8hr!\n🆔 ${orderId}`,
      inprogress:
        `🫧 *Cleaning shuru ho gayi!*\n\n` +
        (updateData.delivery_date ? `📦 Delivery: *${updateData.delivery_date}*\n` : "") +
        `Hum khayal rakh rahe hain. ✨\n🆔 ${orderId}`,
      outfordelivery: `🚚 *Aapka order delivery pe hai!*\n\nFresh kapde jald pahunchenge! 😊\n🆔 ${orderId}`,
      delivered:
        `✅ *Kapde deliver ho gaye!*\n\nThank you for choosing Washkart! 🙏`,
    };
    if (msgs[status] && b?.phone) {
      await sendMessage(b.phone, msgs[status]);
      // After delivery — send rating buttons
      if (status === "delivered") {
        setTimeout(async () => {
          await sendButtons(b.phone,
            "Aapka experience kaisa raha? 😊",
            [{ id: "rating_excellent", title: "🤩 Excellent" }, { id: "rating_good", title: "😊 Good" }, { id: "rating_poor", title: "😞 Needs Work" }]
          );
          if (sessions[b.phone]) sessions[b.phone].step = "feedback";
          // FIX: Also initialise session if customer hasn't messaged yet
          else sessions[b.phone] = { step: "feedback", booking: {}, history: [] };
        }, 2000);
      }
    }
    res.json({ success: true, delivery_date: updateData.delivery_date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/bookings/:orderId", async (req, res) => {
  try {
    await dbDelete("bookings", `order_id=eq.${req.params.orderId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual WhatsApp message from dashboard
app.post("/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "Phone and message required" });
    await sendMessage(normalizePhone(phone), message);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/customers", async (req, res) => {
  try { res.json(await dbSelect("customers", "order=created_at.desc")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/ratings", async (req, res) => {
  try { res.json(await dbSelect("ratings", "order=created_at.desc")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart Bot running on port ${PORT} 🧺`));
