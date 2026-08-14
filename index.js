const express = require("express");
const axios   = require("axios");
const path    = require("path");
const app     = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://www.washkart.co.in',
  'https://washkart.co.in',
  'https://super-glade-8ea3.bhavin2267.workers.dev'
];
app.use((req, res, next) => {
  if (ALLOWED_ORIGINS.includes(req.headers.origin)) {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── BRANCH CONFIG ─────────────────────────────────────────────────
// Add Baner Phone Number ID here when ready — bot goes live instantly
const BRANCHES = {
  "1136879376186203": { name: "Bavdhan", slug: "bavdhan", admin: "917775066002" },
  "BANER_NUMBER_ID":  { name: "Baner",   slug: "baner",   admin: "918888266265" },
};
const DEFAULT_BRANCH = BRANCHES["1136879376186203"]; // used for dashboard walk-ins

function getBranch(phoneNumberId) {
  return BRANCHES[phoneNumberId] || DEFAULT_BRANCH;
}

// ── CONFIG ────────────────────────────────────────────────────────
const TOKEN        = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = "washkart_verify_123";
const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DB           = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS   = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

// ── DB CORE ───────────────────────────────────────────────────────
async function dbInsert(t, d) { return (await axios.post(`${DB}/${t}`, d, { headers: SB_HEADERS })).data; }
async function dbSelect(t, f) { return (await axios.get(`${DB}/${t}?${f}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(t, f, d) { return (await axios.patch(`${DB}/${t}?${f}`, d, { headers: SB_HEADERS })).data; }
async function dbDelete(t, f) { return (await axios.delete(`${DB}/${t}?${f}`, { headers: { ...SB_HEADERS, Prefer: "" } })).data; }

// ── SESSIONS ──────────────────────────────────────────────────────
const sessionCache = {};
const processedMessages = new Set();

function normalizePhone(p) {
  p = p.replace(/\D/g, "");
  if (p.startsWith("91") && p.length === 12) return p;
  if (p.length === 10) return "91" + p;
  return p;
}

async function getSession(phone) {
  if (sessionCache[phone]) return sessionCache[phone];
  try {
    const rows = await dbSelect("sessions", `phone=eq.${phone}`);
    if (rows.length) {
      const s = rows[0];
      sessionCache[phone] = { step: s.step || "idle", booking: s.booking || {}, history: s.history || [] };
    } else {
      sessionCache[phone] = { step: "idle", booking: {}, history: [] };
    }
  } catch { sessionCache[phone] = { step: "idle", booking: {}, history: [] }; }
  return sessionCache[phone];
}

const sessionWriteTimers = {};
function saveSession(phone, session) {
  // Always update in-memory cache immediately — Supabase is best-effort
  sessionCache[phone] = session;
  if (sessionWriteTimers[phone]) clearTimeout(sessionWriteTimers[phone]);
  sessionWriteTimers[phone] = setTimeout(async () => {
    try {
      const rows = await dbSelect("sessions", `phone=eq.${phone}`).catch(() => []);
      const payload = { phone, step: session.step || "idle", booking: session.booking || {}, history: (session.history || []).slice(-12), updated_at: new Date().toISOString() };
      if (rows.length) await dbUpdate("sessions", `phone=eq.${phone}`, payload);
      else             await dbInsert("sessions", payload);
    } catch (e) {
      // Silently fail — in-memory cache still works for current session
      console.log(`[session] DB write skipped for ${phone}: ${e.message}`);
    }
  }, 2000);
}

// ── RATE LIMITING ─────────────────────────────────────────────────
const rateLimitMap = {};
function isRateLimited(phone) {
  const now = Date.now();
  if (!rateLimitMap[phone]) rateLimitMap[phone] = [];
  rateLimitMap[phone] = rateLimitMap[phone].filter(t => now - t < 60000);
  if (rateLimitMap[phone].length >= 10) return true;
  rateLimitMap[phone].push(now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const phone of Object.keys(rateLimitMap)) {
    rateLimitMap[phone] = rateLimitMap[phone].filter(t => now - t < 60000);
    if (!rateLimitMap[phone].length) delete rateLimitMap[phone];
  }
}, 5 * 60 * 1000);

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
function has(t, ...words) {
  return words.some(w => {
    if (w.length <= 3) {
      // Short words need word boundary check to avoid false matches
      // e.g. "na" should not match inside "kitna", "na" should match as standalone
      const regex = new RegExp(`(?:^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
      return regex.test(t);
    }
    return t.includes(w);
  });
}

// ── KEYWORD GROUPS ────────────────────────────────────────────────
const BOOKING_KW = [
  "pickup","pick up","book","schedule","collect","collection","booking","place order","new order","want pickup","need pickup","arrange pickup","send pickup","get pickup","laundry pickup",
  "kapde dene","kapde lene","kapde bhejo","kapde uthao","kapde lo","ghar se lelo","ghar se lo","ghar aao","ghar pe aao","aa jao",
  "pickup karna","pickup chahiye","pickup karo","pickup book karo","pickup lagao","pickup bhejo","pickup de do","mujhe pickup",
  "book karo","book karna","booking karo","booking chahiye","order karo","order dena","order lagao","order book karo",
  "laundry dena","laundry lena","laundry bhejo","laundry chahiye","kapda dena","kapda lena","kapde nikalo","kapde pack karo",
  "dhobi","dhobi bhejo","dhobi ko bulao","dhulai karo","istri karo","press karo","dhona hai","kapde dhone hain",
  "pickup hava","pickup kara","pickup pathva","pickup dyaa","kapde nyaa","kapde ghya","kapde patha","kapde pathva",
  "kapde uthva","kapde uthvayche","kapde dyayche","ghari ya","ghari yaa","ghari ya na","ghari yeva",
  "booking kara","book kara","order kara","order dyaa","laundry dyaa","laundry patha","laundry havi","laundry kara",
  "dhobi patha","kapde dho","kapde istri kara","nyayala ya","ghyayala ya","uthayla ya","collect kara",
  "पिकअप","कपडे न्या","कपडे घ्या","कपडे पाठवा","बुकिंग करा","लॉन्ड्री द्या","घरी या","उचला","कपडे उचला",
  "pickup book karna hai","pickup chahiye mujhe","bhai pickup karo","yaar pickup lo","pickup le lo","aake lo","aake kapde lo",
  "kapde collect karo","kapde le jao","kapde utha lo","booking chahiye bhai","ek booking karo","booking de do",
  "laundry ka pickup","wash karna hai","dry clean karna hai","parso","parso subah","parso shaam",
];
const TRACK_KW = [
  "track","tracking","order status","check order","order track","where is my order","status","delivery status","order update","check status","order info","where are my clothes",
  "kahan hai","kab aayega","kab milega","kab aayenge","delivery kab","order kahan","kapda kahan","kapde kahan hain",
  "mera order","mera kapda","order check","order dekho","status check","status batao","kab tak aayega","kitna time",
  "order hua kya","pickup hua kya","kapde aaye kya","update do","kya hua order ka","order ka kya hua",
  "order kuth aahe","kapde kuth aahet","kev aayil","kev yenar","status sanga","kiti vel lagel","delivery kev honar",
  "kapde aale ka","order update sanga","kath aahe maza order",
  "ऑर्डर कुठे आहे","कपडे कुठे आहेत","स्टेटस सांगा",
  "bhai order kahan hai","yaar status kya hai","order track karo","mujhe batao order kahan hai","kapde kab aayenge bhai",
  "ready hue","ready hai","tayar hue","kapde aaye","order ready","ready ho gaya","ho gaye kya",
  "tayar zale","kapde aale ka","ready aahe ka",
  "kab milega","kab aayega","kab tak aayega","kab deliver","kab pahunchega","kev milel","kev yenar","कपडे तयार",
];
const CANCEL_KW = [
  "cancel","cancellation","cancel order","cancel booking","don't want","dont want","stop","drop it","nevermind",
  "band karo","nahi chahiye","cancel karo","booking cancel","order cancel","raddh","cancel karna","booking band",
  "mat karo","rehne do","chodo","chhodo","band kar do","order band karo","cancel kar do","booking cancel karo",
  "nahi lena","nahi dena","nahi karwana","rokho",
  "cancel kara","nako","nako aahe","radhd kara","thamba","booking nako","order nako","cancel dyaa","band kara",
  "रद्द करा","नको","बंद करा","कॅन्सल करा",
  "yaar cancel karo","bhai cancel kar do","cancel bhai","nahi chahiye bhai","rehne de yaar",
];
const EXPRESS_KW = [
  "express","urgent","fast","quick","asap","rush","same day","today delivery","4 hour","emergency","as soon as possible","immediately","right now delivery",
  "jaldi","jaldi karo","jaldi chahiye","urgent hai","express chahiye","abhi chahiye","aaj chahiye","jaldi deliver karo","jaldi bhejo","urgent pickup","kal tak chahiye","aaj raat tak","kuch ghante mein",
  "lavkar","lavkar kara","lavkar hava","lavkar pathva","urgent aahe","express hava","aaj hava","tvarit",
  "लवकर","तातडीने","अर्जंट",
  "bhai jaldi karo","yaar urgent hai","express lagao","jaldi bhai","fast kar do","express wala",
];
const HELP_KW = [
  "help","menu","options","what can you do","what can","commands","guide","services","how does it work","how to use","what do you offer","info",
  "kya kar sakte","kya karte ho","kya kya hota hai","kaise use kare","samjhao","batao","kya services hain","madad chahiye","madad karo","help chahiye",
  "kay karta","help kara","madat kara","kay suvidha aahe","kasa vaparawa","sangaa","mahiti dya",
  "मदत","माहिती द्या","काय सेवा आहे",
  "bhai kya kya karte ho","yaar help karo","kuch samjha do",
];
const YES_KW = [
  "yes","yep","yup","yeah","sure","correct","confirm","confirmed","alright","absolutely","definitely","proceed","go ahead","done","ok","okay",
  "haan","ha","haa","ji","ji haan","haan ji","ha ji","theek","theek hai","theek hai ji","sahi","sahi hai","bilkul","zaroor","ho ja","kar do","haan kar do","manzoor","agree","chalo","chalega",
  "ho","hoy","hoo","hoy na","chalu kara","kara","theek aahe","barobar","nakkicha",
  "हो","होय","बरोबर","नक्की",
  "haan bhai","ha yaar","ok bhai","done bhai","chal kar do",
];
const NO_KW = [
  "no","nope","nah","not now","later","not yet",
  "nahi","na","nhi","nahin","nai","naa","abhi nahi","baad mein","rehne do","mat karo","nahi chahiye","nahi karna","chhod do",
  "nako","nakos","nahi hav","pudhe",
  "नको","नाही",
  "nahi bhai","na yaar","abhi nahi bhai","nahi re",
];
const SAME_KW = [
  "same as last","same as before","same as last time","repeat","repeat order","same order","same booking","same slot","previous order","last order again",
  "pichli baar jaisa","last wala","wahi wala","wahi time","pehle wala","pehle jaisa","dobara wahi","same karo","wahi order","wahi booking","phir se wahi","usi tarah","pehle jaisi booking",
  "aaglyasarkha","tyach sarkha","last sarkha","same kara","toch order","tich booking","purvicha sarkha",
  "तसेच करा","आधीसारखे",
  "bhai same karo","yaar wahi wala","same de do bhai",
];
const RATES_KW = [
  "rate card","price list","rates","price","pricing","charges","cost","fee","tariff","how much","how much does","what is the price","what are the charges","rate batao",
  "kitna lagta","kitne paise","kitna chahiye","kitna hoga","kitne mein","rate kya hai","price kya hai","charge kya hai","kitne ka","kya rate","daam kya","daam batao","rate list","price batao","charge batao","cost kya hai",
  "kiti lagel","kiti paisa","rate kiti","charge kiti","kiti rupaye","rate sanga","price sanga","kiti ahe","dar kiti","kiti paise lagtat",
  "किती लागेल","दर काय","रेट सांगा","किती रुपये",
  "bhai kitna lagega","yaar rate kya hai","kitna dena padega","rate de do","price de do","charge bata do",
  "specialty","carpet clean","helmet clean","toy wash","bag clean","specialty rates",
  // Short queries like "saree dryclean ka?" "shirt press ka?"
  "dryclean ka","dry clean ka","iron ka","press ka","wash ka","laundry ka","clean ka","shoe ka",
  "dryclean chi","press chi","istri chi","wash chi",
  // Natural Hindi/Marathi queries without "kitna"
  "kitna lagega","kitna padega","kitna hoga","cost kitna","lagega kitna",
  "kiti lagel","kiti padel","dar sanga","kiti rupay",
  "price of","cost of","charge for","rate for",
];
const GREET_KW = [
  "hi","hello","hey","hii","helo","heya","howdy","good morning","good evening","good afternoon","good night","good day","sup","wassup","whatsup","what's up",
  "namaste","namaskar","pranam","jai shri ram","ram ram","jai hind","sat sri akal","adaab","salaam","salam","salaam alaikum","assalam","kya haal","kaise ho","sab theek","kya chal raha","kya haal hai",
  "kasa aahe","kase aahat","kem cho","kay chal","majhet aahe","bhari aahe",
  "नमस्कार","नमस्ते","कसे आहात","जय महाराष्ट्र",
  "bhai hello","yaar hi","bhai kya haal","hello bhai","hi yaar","kem cho bhai",
];
const PAYMENT_KW = [
  "paid","payment done","payment kar diya","pay kar diya","paisa diya","de diya","upi done","upi kar diya","gpay done","phonepe done",
  "payment kela","paisa dila","pay kela","upi kela",
  "पेमेंट केले","पैसे दिले",
  "bhai paid","paid bhai","payment ho gaya","ho gaya payment",
];

// ── DELIVERY TIME KEYWORDS ─────────────────────────────────────────
const DELIVERY_TIME_KW = [
  "how long","kitna time","kab milega","kab tak","delivery time","kitne din","kab ready",
  "kab deliver","when will","time lagega","kitne ghante","turnaround",
  "kiti vel","kev milel","kev tayar","केव मिळेल","कितीवेळ",
  "bhai kab milega","yaar kab aayega","kab tak aayenge kapde",
];

// ── LOCATION KEYWORDS ─────────────────────────────────────────────
const LOCATION_KW = [
  "location","address","where are you","kahan ho","shop kahan","store kahan",
  "kahan hai washkart","office kahan","dukan kahan","shop address",
  "kuth aahe","shop kuth","address sanga","lokeshon","कुठे आहे","पत्ता",
  "bhai kahan ho","washkart kahan hai","where is washkart",
];

// ── WEBSITE / SOCIAL KEYWORDS ──────────────────────────────────────
const WEBSITE_KW = [
  "website","site","instagram","insta","social media","online","web",
  "www","washkart.co.in","_washkart_","facebook","fb page",
  "online dekhna","website dekho",
];

// ── THANKS / ACKNOWLEDGEMENT KEYWORDS ───────────────────────────
const THANKS_KW = [
  "thank you","thanks","thankyou","thank u","thx","ty",
  "shukriya","dhanyawad","shukriyaa","bahut shukriya","bahut dhanyawad",
  "aabhar","dhanya","aabhari","खूप आभारी",
  "bhai thanks","yaar thanks","thanks bhai","thanks yaar",
  "accha","acha","achha","thik hai","theek hai bhai",
];

// ── WRONG NUMBER / WHO ARE YOU KEYWORDS ───────────────────────────
const WRONG_NUMBER_KW = [
  "wrong number","galat number","wrong no","who are you","kaun ho","kya hai ye",
  "ye kaun hai","kiska number","kya number hai","wrong","galat",
  "chukicha number","he kon","kaay ahe he",
];

// ── BULK ORDER KEYWORDS ───────────────────────────────────────────
const BULK_KW = [
  "bulk","large order","bahut saare","bohot kapde","zyada kapde","bulk order",
  "office laundry","hotel laundry","hostel laundry","commercial",
  "20 kapde","25 kapde","30 kapde","50 kapde","100 kapde",
  "bulk kara","jaast kapde","mothi order",
];

// ── "IS ORDER READY" AS TRACK ─────────────────────────────────────
const ORDER_READY_KW = [
  "ready hue","ready hai","tayar hue","tayar hai","kapde aaye","kapde aa gaye",
  "order ready","ready ho gaya","ready kab","kab ready","ho gaye kya",
  "tayar zale","ready zale ka","kapde aale ka","ready aahe ka",
  "कपडे तयार","रेडी झाले",
];

// ── THURSDAY CHECK ────────────────────────────────────────────────
const THURSDAY_KW = [
  "thursday","guruvar","bruhaspativar","गुरुवार","aaj book","aaj pickup",
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
    "🔥 *STEAM IRON RATES*\n━━━━━━━━━━━━━━━\n" +
    "👕 Normal Clothes — ₹20/piece\n" +
    "👘 Kurta (Men) — ₹30/piece\n" +
    "💃 Anarkali — ₹50/piece\n" +
    "🧣 Shawl — ₹50/piece\n" +
    "🛏 Bedsheet — ₹60/piece\n" +
    "🥻 Saree — ₹120/piece\n" +
    "🧥 Blazer — ₹120/piece\n" +
    "👗 Lehenga — ₹120/piece\n" +
    "━━━━━━━━━━━━━━━\n⚠️ Final price confirmed before cleaning",
  dryclean:
    "🧥 *DRY CLEANING RATES*\n━━━━━━━━━━━━━━━\n" +
    "👔 Shirt / T-Shirt / Top — ₹100\n" +
    "👖 Pant / Trouser / Cargos — ₹100\n" +
    "👚 Blouse / Salwar — ₹100\n" +
    "✨ Blouse (with work) — ₹120\n" +
    "🧣 Dupatta — from ₹120\n" +
    "🧶 Sweatshirt / Sweater — from ₹200\n" +
    "🧥 Jacket — ₹250\n" +
    "🧥 Overcoat — ₹400\n" +
    "🧥 Coat / Blazer — ₹300\n" +
    "👔 Suit (2 Piece) — ₹400\n" +
    "👗 Dress (3 Piece) — from ₹350\n" +
    "🥻 Saree — from ₹350\n" +
    "🥻 Saree (Silk) — ₹400\n" +
    "✨ Saree (with work) — ₹450\n" +
    "💃 Lehenga — from ₹350\n" +
    "👜 Bags / Handbags / Purse — from ₹200\n" +
    "🏠 Curtains — ₹15/sq.ft | Towel — ₹150\n" +
    "━━━━━━━━━━━━━━━\n⚠️ Rates confirmed before cleaning starts",
  laundry:
    "🫧 *LAUNDRY RATES*\n━━━━━━━━━━━━━━━\n" +
    "👕 Wash & Fold — ₹80/kg\n" +
    "🧺 Wash & Iron — ₹110/kg\n" +
    "⚡ Express Wash (90 min) — ₹120/kg\n" +
    "⚡ Express Wash & Iron (90 min) — ₹160/kg\n" +
    "━━━━━━━━━━━━━━━\n" +
    "🛏 Bedsheet Single — ₹150 | Double — ₹200\n" +
    "🛌 Blanket/Comforter Single — ₹350 | Double — ₹450\n" +
    "━━━━━━━━━━━━━━━\n📦 Min 1kg | 🚚 Free pickup >₹300",
  shoes:
    "👟 *SHOE CLEANING*\n━━━━━━━━━━━━━━━\n" +
    "👟 Canvas Shoes — ₹300/pair\n" +
    "👟 Sneakers / Sports — ₹350/pair\n" +
    "👞 Suede / Leather — from ₹400/pair\n" +
    "━━━━━━━━━━━━━━━\n⚠️ Price confirmed before cleaning",
  specialty:
    "✨ *SPECIALTY CLEANING*\n━━━━━━━━━━━━━━━\n" +
    "🧸 Soft Toy Cleaning — from ₹200\n" +
    "🪖 Helmet Cleaning — from ₹150\n" +
    "🏠 Carpet Dry Cleaning — from ₹40/sq.ft\n" +
    "👜 Bag Cleaning — from ₹200\n" +
    "━━━━━━━━━━━━━━━\n⚠️ Final price confirmed before cleaning",
};

const HELP_MSG =
  "🧺 *Washkart — What I can do*\n━━━━━━━━━━━━━━━\n" +
  "📦 *Book pickup* — type 'pickup' or just tell me when\n" +
  "💰 *Rates* — type 'rates' or ask any item price\n" +
  "🔍 *Track order* — type 'track'\n" +
  "❌ *Cancel* — type 'cancel'\n" +
  "⚡ *Express* — type 'express' after pickup\n" +
  "🔄 *Repeat booking* — type 'same as last time'\n" +
  "━━━━━━━━━━━━━━━\n" +
  "🌐 www.washkart.co.in | 📸 @_washkart_\n" +
  "Hindi, Marathi, English sab chalega! 😊\nClosed on *Thursdays* 🙏";

// ── ESTIMATE ENGINE ───────────────────────────────────────────────
const ITEM_PRICES = {
  shirt:{dryclean:100,iron:20,laundry:80},pant:{dryclean:100,iron:20,laundry:80},
  trouser:{dryclean:100,iron:20,laundry:80},jeans:{dryclean:100,iron:20,laundry:80},
  tshirt:{dryclean:100,iron:20,laundry:80},top:{dryclean:100,iron:20,laundry:80},
  kurta:{dryclean:100,iron:30,laundry:80},kurti:{dryclean:100,iron:30,laundry:80},
  blouse:{dryclean:100,iron:20},salwar:{dryclean:100,iron:20},
  saree:{dryclean:350,iron:120},lehenga:{dryclean:350,iron:120},
  blazer:{dryclean:300,iron:120},jacket:{dryclean:250,iron:60},
  overcoat:{dryclean:400,iron:60},sweater:{dryclean:200,iron:40},
  dupatta:{dryclean:120,iron:50},shawl:{dryclean:120,iron:50},
  anarkali:{dryclean:200,iron:50},suit:{dryclean:400,iron:100},
  dress:{dryclean:350,iron:60},gown:{dryclean:350,iron:120},
  sherwani:{dryclean:400,iron:120},towel:{dryclean:150},
  sneaker:{shoes:350},shoe:{shoes:350},canvas:{shoes:300},leather:{shoes:400},
  bedsheet:{laundry:150,iron:60},blanket:{laundry:350},curtain:{dryclean:15},
  bag:{specialty:200},helmet:{specialty:150},carpet:{specialty:40},toy:{specialty:200},
};
function detectServiceNear(fullText, matchIndex, matchLength) {
  const w = fullText.toLowerCase().substring(Math.max(0,matchIndex-30), matchIndex+matchLength+30);
  if (/dry\s*clean|dryclean|dry-clean|\bdc\b|chemical/.test(w)) return "dryclean";
  if (/\biron\b|press|istri|steam/.test(w)) return "iron";
  if (/\bwash\b|\blaundry\b|dhulai|fold/.test(w)) return "laundry";
  if (/\bshoe|\bsneaker|\bjoote|footwear/.test(w)) return "shoes";
  return null;
}
function extractEstimateItems(rawText) {
  // Normalize Marathi/Hindi conjunctions to "and"
  rawText = rawText.replace(/\bani\b/gi, "and").replace(/\baur\b/gi, "and").replace(/\bor\b/gi, "and");
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
      .replace(/sarees?$/,"saree").replace(/shirts?$/,"shirt").replace(/pants?$/,"pant")
      .replace(/trousers?$/,"trouser").replace(/kurtas?$/,"kurta").replace(/kurtis?$/,"kurti")
      .replace(/suits?$/,"suit").replace(/dresses?$/,"dress").replace(/jackets?$/,"jacket")
      .replace(/sweaters?$/,"sweater").replace(/lehengas?$|lehnga$/,"lehenga")
      .replace(/blazers?$/,"blazer").replace(/dupattas?$/,"dupatta")
      .replace(/bedsheets?$/,"bedsheet").replace(/blankets?$/,"blanket")
      .replace(/sneakers?$/,"sneaker").replace(/shoes?$/,"shoe").replace(/slides?$/,"slide")
      .replace(/t-shirts?$|tshirts?$/,"tshirt").replace(/gowns?$/,"gown").replace(/sherwanis?$/,"sherwani");
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
    const priceRow = ITEM_PRICES[key] || ITEM_PRICES[key+"s"] || ITEM_PRICES[key.replace(/s$/,"")];
    const unitPrice = priceRow?.[svc];
    if (unitPrice) {
      total += unitPrice * qty;
      const lbl = svc==="dryclean"?"Dry Clean":svc==="iron"?"Iron":svc==="laundry"?"Laundry":"Shoe Clean";
      breakdown.push(`${qty}x ${item.name} (${lbl}) — ₹${unitPrice*qty}`);
    } else { unknown.push(`${item.qty}x ${item.name}`); }
  }
  return { total, breakdown, unknown };
}

// ── SEND HELPERS ──────────────────────────────────────────────────
async function sendMessage(to, text, phoneNumberId) {
  const numId = phoneNumberId || "1136879376186203";
  try {
    const res = await axios.post(`https://graph.facebook.com/v25.0/${numId}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[sendMessage] ✅ to:${to} via:${numId} status:${res.status}`);
  } catch (e) {
    console.error(`[sendMessage] ❌ to:${to}:`, JSON.stringify(e?.response?.data || e.message));
  }
}
async function sendButtons(to, body, buttons, phoneNumberId) {
  const numId = phoneNumberId || "1136879376186203";
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${numId}/messages`,
      { messaging_product:"whatsapp", to, type:"interactive",
        interactive:{ type:"button", body:{ text:body },
          action:{ buttons: buttons.slice(0,3).map(b=>({ type:"reply", reply:{ id:b.id, title:b.title.slice(0,20) } })) }
        }
      },
      { headers:{ Authorization:`Bearer ${TOKEN}`, "Content-Type":"application/json" } }
    );
  } catch (e) { console.error("sendButtons error:", e?.response?.data || e.message); }
}

// ── DB HELPERS ────────────────────────────────────────────────────
async function getCustomer(phone) {
  try { const r = await dbSelect("customers", `phone=eq.${phone}`); return r[0] || null; } catch { return null; }
}
async function saveCustomer(phone, name, address, branch) {
  try {
    const ex = await getCustomer(phone);
    if (ex) await dbUpdate("customers", `phone=eq.${phone}`, { name, address, branch: branch || ex.branch || "bavdhan" });
    else await dbInsert("customers", { phone, name, address, branch: branch || "bavdhan" });
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
async function saveRating(phone, orderId, rating, comment, branch) {
  try { await dbInsert("ratings", { phone, order_id: orderId, rating, comment, branch: branch || "bavdhan", created_at: new Date().toISOString() }); }
  catch (e) { console.error("saveRating:", e.message); }
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────
async function notifyAdmin(booking, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  const src = booking.source ? ` [${booking.source}]` : "";
  await sendMessage(br.admin,
    `🔔 *New Booking!*${src} [${br.name}]\n\n🆔 ${booking.orderId}\n👤 ${booking.name}\n📱 +${booking.phone}\n📍 ${booking.address || "Walk-in"}\n📅 ${booking.date || "—"}\n🕐 ${booking.slot || "—"}`,
    phoneNumberId
  );
}
async function notifyAdminComplaint(phone, name, message, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin, `⚠️ *Complaint!* [${br.name}]\n\n👤 ${name||"Unknown"}\n📱 +${phone}\n💬 "${message}"\n\n_Please follow up._`, phoneNumberId);
}
async function notifyAdminRating(phone, name, orderId, rating, comment, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin, `⭐ *New Rating* [${br.name}]\n\n👤 ${name||phone}\n🆔 ${orderId||"unknown"}\n⭐ ${rating}/5\n💬 ${comment||"No comment"}`, phoneNumberId);
}
async function notifyAdminPayment(phone, name, orderId, amount, method, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin,
    `💰 *Payment Received* [${br.name}]\n\n👤 ${name||phone}\n🆔 ${orderId||"unknown"}\n💵 ₹${amount}\n💳 ${method}\n\nConfirm? Reply *CONFIRM ${orderId}* or *REJECT ${orderId}*`,
    phoneNumberId
  );
}

// ── POST-RATING UPSELL ────────────────────────────────────────────
async function sendPostRatingUpsell(phone, phoneNumberId) {
  setTimeout(async () => {
    await sendButtons(phone, "Agle baar pickup chahiye? 🧺",
      [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_track", title:"🔍 Track Order" }],
      phoneNumberId
    );
  }, 2000);
}

// ── BOOKING HELPERS ───────────────────────────────────────────────
async function askDate(phone, phoneNumberId) {
  const buttons = [];
  if (!isTodayThursday())    buttons.push({ id:"date_today",    title:"📅 Today" });
  if (!isTomorrowThursday()) buttons.push({ id:"date_tomorrow", title:"📅 Tomorrow" });
  buttons.push({ id:"date_custom", title:"📆 Other date" });
  await sendButtons(phone, "📅 Kaunse din pickup karein?\n\n_(Closed Thursdays)_", buttons, phoneNumberId);
}
async function askSlot(phone, phoneNumberId) {
  const now  = new Date();
  const hour = now.getHours();
  const min  = now.getMinutes();
  const morningOpen = hour < 9 || (hour === 9 && min < 30);
  if (hour >= 16) {
    await sendMessage(phone, "Aaj ke slots bhar gaye 😊\nKal ke liye book karein!", phoneNumberId);
    await askDate(phone, phoneNumberId); return;
  }
  const buttons = [];
  if (morningOpen) buttons.push({ id:"slot_morning", title:"🌅 10 AM – 1 PM" });
  buttons.push({ id:"slot_evening", title:"🌆 5 PM – 8 PM" });
  const note = morningOpen ? "Time slot choose karein:" : "Morning slot closed. Evening slot available:";
  await sendButtons(phone, `🕐 ${note}`, buttons, phoneNumberId);
}
async function askPriceCategory(phone, phoneNumberId) {
  await sendButtons(phone, "💰 Kaunsi service ke rates chahiye?",
    [{ id:"price_iron", title:"🔥 Steam Iron" }, { id:"price_dc", title:"🧥 Dry Clean" }, { id:"price_wash", title:"🫧 Laundry" }],
    phoneNumberId
  );
  setTimeout(() => sendButtons(phone, "👇 Aur:", [{ id:"price_shoe", title:"👟 Shoes" }, { id:"price_specialty", title:"✨ Specialty" }, { id:"btn_book", title:"📦 Book Pickup" }], phoneNumberId), 700);
}
async function showBookingConfirm(phone, session, phoneNumberId) {
  const bk = session.booking;
  await sendButtons(phone,
    `Got it! 👍\n\n📅 ${bk.date}\n🕐 ${bk.slot}\n📍 ${bk.address}\n\nConfirm booking?`,
    [{ id:"confirm_direct", title:"✅ Confirm" }, { id:"date_custom", title:"📆 Change date" }, { id:"update_details", title:"✏️ Change address" }],
    phoneNumberId
  );
  session.step = "direct_confirm";
}
async function confirmBooking(phone, booking, branch, phoneNumberId) {
  const orderId = genOrderId();
  booking.orderId = orderId; booking.phone = phone;
  const br = branch || DEFAULT_BRANCH;
  try {
    await dbInsert("bookings", {
      order_id: orderId, name: booking.name, phone,
      address: booking.address || "", date: booking.date || "", slot: booking.slot || "",
      status: "pending", reminder_sent: false,
      source: booking.source || "whatsapp",
      branch: br.slug,
      amount: 0, payment_status: "unpaid", payment_method: "",
    });
  } catch (e) { console.error("saveBooking:", e.message); }
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n🆔 *${orderId}*\n👤 ${booking.name}\n📍 ${booking.address || "—"}\n📅 ${booking.date || "—"}\n🕐 ${booking.slot || "—"}\n\n` +
    `Our team will arrive within your slot. 💚\n💰 Payment via UPI QR / Cash at delivery.\n\nCancel karne ke liye: *cancel*`,
    phoneNumberId
  );
  // Post-booking express upsell
  setTimeout(async () => {
    await sendMessage(phone,
      `⚡ *Express chahiye?*\n\nPickup ke baad *EXPRESS* reply karein — 4-8 hours mein kapde deliver! (1.5x charge)`,
      phoneNumberId
    );
  }, 3000);
  await notifyAdmin(booking, br, phoneNumberId);
}

// ── GEMINI AI ─────────────────────────────────────────────────────
async function geminiChat(phone, userMessage, session, customer, activeOrder, lastOrder, branch) {
  const br = branch || DEFAULT_BRANCH;
  const history = (session.history || []).slice(-6);
  const systemPrompt = `You are ${br.name} Washkart Assistant — a friendly WhatsApp laundry bot for Washkart ${br.name}, Pune, Maharashtra.

RULES:
1. Reply in SAME language as customer (Hindi/Marathi/Hinglish/English). If they write in Marathi, reply in Marathi.
2. SHORT replies — max 3-4 lines. Friendly, use emojis
3. CLOSED on Thursdays — suggest another day
4. Never invent prices
5. Always sign off as "Washkart ${br.name}" not just "Washkart"

MARATHI DATE/TIME WORDS:
- "आज"/"aaj" = today | "उद्या"/"udya" = tomorrow | "परवा"/"parso" = day after tomorrow
- "सकाळी"/"sakali" = morning | "संध्याकाळी"/"sandhyakal" = evening | "गुरुवार"/"guruvar" = Thursday (CLOSED)

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
Steam Iron: Normal ₹20/pc, Kurta ₹30/pc, Anarkali/Shawl ₹50/pc, Bedsheet ₹60/pc, Saree/Blazer/Lehenga ₹120/pc
Dry Clean: Shirt/Pant/Blouse/Salwar ₹100, Blouse(work) ₹120, Dupatta from ₹120, Sweater from ₹200, Jacket ₹250, Overcoat ₹400, Blazer ₹300, Suit ₹400, Saree from ₹350, Silk Saree ₹400, Saree(work) ₹450, Lehenga from ₹350, Bag from ₹200, Curtains ₹15/sqft, Towel ₹150
Laundry: Wash & Fold ₹80/kg, Wash & Iron ₹110/kg, Express Wash ₹120/kg, Express Wash & Iron ₹160/kg
Bedsheets: Single ₹150, Double ₹200 | Blanket: Single ₹350, Double ₹450
Shoes: Canvas ₹300/pair, Sneakers/Sports ₹350/pair, Leather from ₹400/pair
Specialty: Soft Toy from ₹200, Helmet from ₹150, Carpet from ₹40/sqft, Bag from ₹200
Free pickup above ₹300.

RESPOND with JSON only (no markdown):
{
  "reply": "your friendly reply",
  "action": "none"|"book_now"|"need_name"|"need_address"|"need_date"|"need_slot"|"show_iron"|"show_dryclean"|"show_laundry"|"show_shoes"|"show_rates_menu"|"track_order"|"complaint"|"estimate",
  "extracted": { "name": null, "address": null, "date": "today"|"tomorrow"|"day_after_tomorrow"|"date string"|null, "slot": "morning"|"evening"|null, "items": null }
}

HISTORY:
${history.map(h=>`${h.role}: ${h.text}`).join("\n")}`;

  try {
    const res = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nCustomer: "${userMessage}"` }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    });
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let clean = raw.replace(/```json|```/g,"").trim();
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
async function handleMessage(phone, rawText, phoneNumberId) {
  phone = normalizePhone(phone);
  const branch = getBranch(phoneNumberId);

  if (isRateLimited(phone)) {
    console.log(`[rate-limit] ${phone} exceeded 10 msg/min`);
    return;
  }

  const session = await getSession(phone);
  const t = norm(rawText);

  if (!session.history) session.history = [];
  session.history.push({ role: "customer", text: rawText });
  if (session.history.length > 12) session.history = session.history.slice(-12);
  saveSession(phone, session);

  // Shorthand helpers that pass phoneNumberId through
  const send    = (msg)           => sendMessage(phone, msg, phoneNumberId);
  const sendBtn = (msg, btns)     => sendButtons(phone, msg, btns, phoneNumberId);

  // ══ LAYER 1: Active session steps ════════════════════════════════

  if (session.step === "get_name") {
    if (rawText.trim().length < 2) { await send("Please apna naam share karein 😊"); return; }
    session.booking.name = rawText.trim();
    session.step = "idle";
    if (!session.booking.address) { session.step = "get_address"; await send(`Thanks ${session.booking.name}! 😊\n\n📍 Apna pickup address bhejein:`); }
    else if (!session.booking.date) { await askDate(phone, phoneNumberId); session.step = "select_date"; }
    else if (!session.booking.slot) { await askSlot(phone, phoneNumberId); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session, phoneNumberId); }
    saveSession(phone, session); return;
  }

  if (session.step === "get_address") {
    if (rawText.trim().length < 3) { await send("📍 Apna complete address bhejein:"); return; }
    session.booking.address = rawText.trim();
    if (session.booking.name) await saveCustomer(phone, session.booking.name, session.booking.address, branch.slug);
    session.step = "idle";
    if (!session.booking.date) { await askDate(phone, phoneNumberId); session.step = "select_date"; }
    else if (!session.booking.slot) { await askSlot(phone, phoneNumberId); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session, phoneNumberId); }
    saveSession(phone, session); return;
  }

  if (session.step === "get_custom_date") {
    if (isThursdayStr(rawText)) {
      await send("Thursday ko hum band rehte hain 🙏\nKoi aur din batao:");
      await askDate(phone, phoneNumberId);
      return;
    }
    // Also check if typed date is a past date
    const typed = rawText.trim().toLowerCase();
    // Basic check — if they type just a number that's less than today's date in same month
    const dayNum = parseInt(typed);
    if (!isNaN(dayNum)) {
      const today = new Date();
      if (dayNum < today.getDate() && typed.length <= 2) {
        await send("Ye date toh nikal gayi 😊 Aage ki date batao:");
        return;
      }
    }
    session.booking.date = rawText.trim(); session.step = "idle";
    if (!session.booking.slot) { await askSlot(phone, phoneNumberId); session.step = "select_slot"; }
    else { await showBookingConfirm(phone, session, phoneNumberId); }
    saveSession(phone, session); return;
  }

  if (session.step === "tracking") {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings", `order_id=eq.${m[0].toUpperCase()}`).catch(()=>[]);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
        const del = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
        await send(`🆔 *${rows[0].order_id}*\n${s.label}${del}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
      } else { await send("Order nahi mila. ID check karein 😊"); }
      session.step = "idle"; saveSession(phone, session); return;
    }
    // After invalid ID, give them an escape option
    session.step = "idle"; saveSession(phone, session);
    await sendBtn("Valid Order ID bhejein, jaise *FW-1234* 😊\n\nYa naya pickup book karein:",
      [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_track", title:"🔍 Try Again" }]
    );
    return;
  }

  if (session.step === "confirm_cancel") {
    if (rawText.startsWith("cc_")) {
      const orderId = rawText.replace("cc_","");
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`).catch(()=>[]);
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { status:"cancelled" });
      await send(`✅ Order *${orderId}* cancel ho gaya.\nPhir se book karna ho: *pickup* 🧺`);
      if (rows[0]) await sendMessage(branch.admin, `❌ *Cancelled* [${branch.name}]\n🆔 ${orderId}\n👤 ${rows[0].name}\n📅 ${rows[0].date}`, phoneNumberId);
    } else if (rawText === "no_cancel") {
      await send("Theek hai! Order still active hai 👍");
    } else { await send("Cancel karna hai to 'Yes, Cancel' dabao."); return; }
    session.step = "idle"; saveSession(phone, session); return;
  }

  if (session.step === "direct_confirm") {
    if (rawText === "confirm_direct" || has(t, ...YES_KW)) {
      session.step = "idle";
      const bk = session.booking;
      if (bk.name && bk.address && bk.date && bk.slot) {
        await confirmBooking(phone, bk, branch, phoneNumberId); session.booking = {};
      } else { await send("Kuch details missing hain. *pickup* se dobara try karein."); }
      saveSession(phone, session); return;
    }
    if (rawText === "date_custom") { session.step = "get_custom_date"; await send("📅 Date type karein (e.g. *28 April*):"); saveSession(phone, session); return; }
    if (rawText === "update_details") { session.booking = {}; session.step = "get_address"; await send("📍 Naya address bhejein:"); saveSession(phone, session); return; }
    if (has(t, ...NO_KW)) { session.step = "idle"; session.booking = {}; await send("No problem! Jab ready ho: *pickup* 😊"); saveSession(phone, session); return; }
    await showBookingConfirm(phone, session, phoneNumberId); return;
  }

  // ── FEEDBACK ─────────────────────────────────────────────────────
  if (session.step === "feedback") {
    const ratingMap = { "rating_excellent":5, "rating_good":4, "rating_poor":2 };
    const lastOrder = await getLastOrder(phone);
    const customer  = await getCustomer(phone);
    if (ratingMap[rawText] !== undefined) {
      const stars = ratingMap[rawText];
      await saveRating(phone, lastOrder?.order_id, stars, null, branch.slug);
      await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, stars, null, branch, phoneNumberId);
      if (stars === 5) {
        await send("Shukriya! ⭐⭐⭐⭐⭐ Aapka support bahut matlab rakhta hai! 🙏\nMilte hain agli baar Washkart pe!");
        session.step = "idle"; saveSession(phone, session);
        await sendPostRatingUpsell(phone, phoneNumberId);
      } else if (stars === 4) {
        await send("Thanks! 😊 Kuch aur better kar sakte hain? Batao — hum improve karenge!");
        session.step = "feedback_comment"; saveSession(phone, session);
      } else {
        await send("Bahut sorry for the experience 🙏\nKya problem aayi? Batao — hum zaroor fix karenge.");
        await notifyAdminComplaint(phone, customer?.name, `Low rating (${stars}/5)`, branch, phoneNumberId);
        session.step = "feedback_comment"; saveSession(phone, session);
      }
      return;
    }
    await saveRating(phone, lastOrder?.order_id, null, rawText, branch.slug);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "text", rawText, branch, phoneNumberId);
    await send("Shukriya feedback ke liye! 🙏 Milte hain agli baar!");
    session.step = "idle"; saveSession(phone, session);
    await sendPostRatingUpsell(phone, phoneNumberId); return;
  }

  if (session.step === "feedback_comment") {
    const lastOrder = await getLastOrder(phone);
    const customer  = await getCustomer(phone);
    await saveRating(phone, lastOrder?.order_id, null, rawText, branch.slug);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "comment", rawText, branch, phoneNumberId);
    await send("Shukriya! 🙏 Hum aur better karenge. Milte hain agli baar!");
    session.step = "idle"; saveSession(phone, session);
    await sendPostRatingUpsell(phone, phoneNumberId); return;
  }

  // ── PAYMENT CONFIRMATION ──────────────────────────────────────────
  if (session.step === "payment_method") {
    const active = await getActiveOrder(phone);
    const customer = await getCustomer(phone);
    const orderId = session.paymentOrderId || active?.order_id;
    let method = "UPI";
    if (rawText === "pay_cash" || has(t, "cash","nakad","नकद")) method = "Cash";
    else if (rawText === "pay_upi" || has(t, "upi","gpay","phonepe","paytm","online")) method = "UPI";
    await send(`✅ Got it! ${method} payment noted 🙏\nAdmin confirm karega jald hi.`);
    await notifyAdminPayment(phone, customer?.name, orderId, session.paymentAmount || 0, method, branch, phoneNumberId);
    session.step = "idle";
    delete session.paymentOrderId;
    delete session.paymentAmount;
    saveSession(phone, session); return;
  }

  // ── ADMIN PAYMENT CONFIRM ─────────────────────────────────────────
  // Admin replies CONFIRM FW-XXXX or REJECT FW-XXXX
  if (phone === normalizePhone(branch.admin)) {
    const confirmMatch = rawText.match(/^CONFIRM\s+(FW-\d+)/i);
    const rejectMatch  = rawText.match(/^REJECT\s+(FW-\d+)/i);
    if (confirmMatch) {
      const orderId = confirmMatch[1].toUpperCase();
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`).catch(()=>[]);
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { payment_status:"paid", payment_date: new Date().toISOString() });
      await send(`✅ Payment confirmed for ${orderId}`);
      if (rows[0]?.phone) await sendMessage(rows[0].phone, `✅ *Payment Confirmed!*\n\nThank you for paying for order *${orderId}* 🙏\nMilte hain agli baar Washkart ${branch.name} pe!`, phoneNumberId);
      return;
    }
    if (rejectMatch) {
      const orderId = rejectMatch[1].toUpperCase();
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`).catch(()=>[]);
      await send(`❌ Payment rejected for ${orderId} — follow up with customer`);
      if (rows[0]?.phone) await sendMessage(rows[0].phone, `Hi! Washkart ${branch.name} se baat kar rahe hain.\n\n💰 Order *${orderId}* ka payment confirm nahi hua.\nPlease UPI QR se payment karein ya call karein. 🙏`, phoneNumberId);
      return;
    }
  }

  // ══ LAYER 2: Button IDs ══════════════════════════════════════════
  if (rawText === "price_iron")     { await send(RATES.iron); return; }
  if (rawText === "price_dc")       { await send(RATES.dryclean); return; }
  if (rawText === "price_wash")     { await send(RATES.laundry); return; }
  if (rawText === "price_shoe")     { await send(RATES.shoes); return; }
  if (rawText === "price_specialty") { await send(RATES.specialty); return; }
  if (rawText === "btn_price")      { await askPriceCategory(phone, phoneNumberId); return; }
  if (rawText === "btn_track")      { await handleTrack(phone, session, null, phoneNumberId); return; }
  if (rawText === "date_today")     { await handleDateButton(phone, session, "today", phoneNumberId); return; }
  if (rawText === "date_tomorrow")  { await handleDateButton(phone, session, "tomorrow", phoneNumberId); return; }
  if (rawText === "date_custom")    { session.step = "get_custom_date"; saveSession(phone, session); await send("📅 Date type karein (e.g. *28 April*):\n_(Closed Thursdays)_"); return; }
  if (rawText === "slot_morning")   { session.booking.slot = "Morning (10 AM – 1 PM)"; await handleSlotSelected(phone, session, phoneNumberId); return; }
  if (rawText === "slot_evening")   { session.booking.slot = "Evening (5 PM – 8 PM)"; await handleSlotSelected(phone, session, phoneNumberId); return; }
  if (rawText === "use_saved")      { const s = await getCustomer(phone); if (s) { session.booking.name = s.name; session.booking.address = s.address; } await askDate(phone, phoneNumberId); session.step = "select_date"; saveSession(phone, session); return; }
  if (rawText === "update_details") { session.booking = {}; session.step = "get_address"; saveSession(phone, session); await send("📍 Naya address bhejein:"); return; }
  if (rawText === "no_cancel")      { await send("Theek hai! Order still active 👍"); return; }
  if (rawText === "confirm_direct") {
    // Fix: if step is idle but booking data is complete, still confirm
    const bk = session.booking;
    if (session.step === "direct_confirm" || (bk.name && bk.address && bk.date && bk.slot)) {
      session.step = "idle";
      if (bk.name && bk.address && bk.date && bk.slot) {
        await confirmBooking(phone, bk, branch, phoneNumberId);
        session.booking = {};
      } else {
        await send("Kuch details missing hain. *pickup* se dobara try karein.");
      }
      saveSession(phone, session);
    }
    return;
  }
  if (rawText === "btn_book")       { session.booking = {}; }

  // ══ LAYER 3: Keyword shortcuts ════════════════════════════════════

  // ── Media types ──────────────────────────────────────────────────
  if (rawText === "__audio__")    { await send("Voice notes nahi sun sakta 😊 Please type karein!"); return; }
  if (rawText === "__image__")    { await send("Photos nahi dekh sakta 😊 Please describe karein ya *pickup* book karein!"); return; }
  if (rawText === "__video__")    { await send("Videos nahi dekh sakta 😊 Please type karein!"); return; }
  if (rawText === "__document__") { await send("Documents nahi open kar sakta 😊 Please type karein!"); return; }
  if (rawText === "__sticker__")  { await send("😊 Washkart mein aapka swagat hai!\n\n*pickup* — booking\n*rates* — prices\n*track* — order status"); return; }

  // Thursday check
  if (isTodayThursday() && !has(t, "track","status","order","cancel","paid","rating","feedback")) {
    await sendBtn("Aaj *Thursday* hai — Washkart band hai 🙏 Kal se phir open! Kal ke liye book karein?",
      [{ id:"date_tomorrow", title:"📅 Book Tomorrow" }, { id:"btn_track", title:"🔍 Track Order" }]
    );
    return;
  }

  // Wrong number
  if (has(t, ...WRONG_NUMBER_KW)) {
    await send("Hi! Yeh *Washkart " + branch.name + "* ka WhatsApp bot hai. Pune mein premium laundry service. www.washkart.co.in | @_washkart_ | Kuch chahiye? *pickup* ya *rates* type karein");
    return;
  }

  // Location
  if (has(t, ...LOCATION_KW)) {
    await send("Washkart Locations\n━━━━━━━━━━━━━━━\nBavdhan: Near DSK Vishwa, Bavdhan, Pune\nBaner: Baner, Pune\n\nDoorstep pickup & delivery!\nwww.washkart.co.in");
    return;
  }

  // Website
  if (has(t, ...WEBSITE_KW)) {
    await send("Washkart Online\n━━━━━━━━━━━━━━━\nWebsite: www.washkart.co.in\nInstagram: @_washkart_\n\nPickup ke liye: *pickup*");
    return;
  }

  // Delivery time
  if (has(t, ...DELIVERY_TIME_KW)) {
    const activeForTime = await getActiveOrder(phone);
    if (activeForTime && activeForTime.delivery_date) {
      await send("Order " + activeForTime.order_id + "\n" + (STATUS_MAP[activeForTime.status]?.label || activeForTime.status) + "\nEst. Delivery: " + activeForTime.delivery_date);
    } else {
      await send("Delivery Time\n━━━━━━━━━━━━━━━\nSteam Iron: 24-36 hrs\nLaundry: 2-3 days\nDry Clean: 3-4 days\nShoes: 2 days\nExpress: 4-8 hours (1.5x)\n\nClosed Thursdays");
    }
    return;
  }

  // Bulk order
  if (has(t, ...BULK_KW)) {
    await send("Bulk Order? Bahut badhiya! Bulk orders ke liye special rates available hain. Hamara team aapko call karega. Ya *pickup* type karein.");
    await sendMessage(branch.admin, "Bulk Order Inquiry from " + phone + ": " + rawText + " - Please follow up!", phoneNumberId);
    return;
  }

  // ── Order ready / is it done ──────────────────────────────────────
  if (has(t, ...ORDER_READY_KW) || has(t, "ready hua","ready hue","kapde ready","tayar hua","order complete","complete hua","clean hua","ho gaye")) {
    await handleTrack(phone, session, rawText, phoneNumberId); return;
  }

  // Thanks / acknowledgements — short friendly reply, no Gemini
  if (has(t, ...THANKS_KW)) {
    const customer = await getCustomer(phone);
    const name = customer?.name ? customer.name + " ji" : "aapka";
    await send("Shukriya " + name + "! 😊 Koi aur kaam ho to batana. *pickup* — booking 🧺");
    return;
  }

  // Standalone "ok/done/theek" outside of a session step — just acknowledge
  if (!session.step || session.step === "idle") {
    const ackWords = ["ok","okay","done","theek","theek hai","accha","acha","achha","sahi","noted","hmm","hm"];
    if (ackWords.some(w => t.trim() === w || t.trim() === w + " ji" || t.trim() === w + " bhai")) {
      await sendBtn("Theek hai! 😊 Kuch aur chahiye?",
        [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_price", title:"💰 Rates" }, { id:"btn_track", title:"🔍 Track Order" }]
      );
      return;
    }
  }

  if (has(t, ...HELP_KW))           { await send(HELP_MSG); return; }
  if (has(t, ...CANCEL_KW))         { await handleCancel(phone, session, rawText, branch, phoneNumberId); return; }
  if (has(t, ...TRACK_KW))          { await handleTrack(phone, session, rawText, phoneNumberId); return; }
  if (has(t, ...EXPRESS_KW) && session.step === "idle") { await handleExpress(phone, branch, phoneNumberId); return; }
  if (has(t, ...SAME_KW))           { await handleSameAsLast(phone, session, phoneNumberId); return; }
  if (has(t, ...PAYMENT_KW))        { await handlePayment(phone, session, branch, phoneNumberId); return; }

  // Greetings
  if (has(t, ...GREET_KW)) {
    const customer = await getCustomer(phone);
    const active   = await getActiveOrder(phone);
    if (customer) {
      if (active) {
        // Short and to the point for returning customers with active order
        await sendBtn(`${customer.name} ji! 👋 Order *${active.order_id}* — ${STATUS_MAP[active.status]?.label}`,
          [{ id:"btn_track", title:"🔍 Track Order" }, { id:"btn_book", title:"📦 New Booking" }]
        );
      } else {
        // Returning customer, no active order
        await sendBtn(`${customer.name} ji, swagat hai! 👋`,
          [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_price", title:"💰 Rates" }, { id:"btn_track", title:"🔍 Track Order" }]
        );
      }
    } else {
      // New customer
      await sendBtn(`Hi! 👋 *Washkart ${branch.name}* mein swagat hai!\n\nPune ka trusted laundry 🧺`,
        [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_price", title:"💰 Rates" }, { id:"btn_track", title:"🔍 Track Order" }]
      );
    }
    return;
  }

  // Rates
  // ── "Do you do X?" service availability questions ───────────────
  const SERVICE_AVAIL = [
    { kw:["curtain","parda","curtains"],       reply:"Yes! 🏠 *Curtain Cleaning* karte hain\n\nDry Clean — ₹15/sq.ft\nPickup & delivery included!\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["carpet","rug","darri"],             reply:"Yes! 🏠 *Carpet Dry Cleaning* karte hain\n\nFrom ₹40/sq.ft\nPickup & delivery included!\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["helmet","helmet clean"],            reply:"Yes! 🪖 *Helmet Cleaning* karte hain\n\nFrom ₹150/helmet\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["soft toy","teddy","stuffed toy","toy clean"], reply:"Yes! 🧸 *Soft Toy Cleaning* karte hain\n\nFrom ₹200\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["sofa","sofa cover","upholstery"],   reply:"Yes! 🛋 *Sofa Cover Cleaning* karte hain\n\nPricing depends on size — please call or book a pickup and our team will assess!\n\nPickup: *pickup* 🧺" },
    { kw:["bag","purse","handbag"],            reply:"Yes! 👜 *Bag & Purse Cleaning* karte hain\n\nFrom ₹200\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["shoe","joote","sneaker","footwear"], reply:"Yes! 👟 *Shoe Cleaning* karte hain\n\nCanvas — ₹300 | Sneakers/Sports — ₹350 | Leather — from ₹400\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["lehenga","lehnga"],                 reply:"Yes! 💃 *Lehenga* dry clean karte hain\n\nFrom ₹350\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["saree","sari"],                     reply:"Yes! 🥻 *Saree* dry clean karte hain\n\nRegular ₹350 | Silk ₹400 | With work ₹450\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["blanket","razai","comforter","quilt"], reply:"Yes! 🛌 *Blanket/Comforter* wash karte hain\n\nSingle ₹350 | Double ₹450\n\nPickup ke liye: *pickup* 🧺" },
    { kw:["bedsheet","bed sheet","chadar"],    reply:"Yes! 🛏 *Bedsheet* wash karte hain\n\nSingle ₹150 | Double ₹200\n\nPickup ke liye: *pickup* 🧺" },
  ];
  // Match "kya aap X karte ho", "X clean karte ho", "X hoti hai", "X milti hai" etc.
  const isAvailQuery = has(t, "kya aap","karte ho","karte hain","milti hai","hoti hai","available","karta ho","karta hai","do you","can you","aap karte","tum karte","tumhare paas","hoga","hote hain","ho sakta","ho sakti","hai kya","karte ka","karte ka","karto ka","milega kya","hota hai");
  if (isAvailQuery) {
    for (const s of SERVICE_AVAIL) {
      if (s.kw.some(k => t.includes(k))) {
        await send(s.reply);
        return;
      }
    }
  }

  if (has(t, ...RATES_KW)) {
    // ── Smart item-specific price lookup ─────────────────────────
    // Detect item + service combination and reply with exact price
    const ITEM_PRICE_QUICK = [
      // Laundry
      { items:["saree","sari"], svc:["wash","laundry","dhulai"], reply:"🥻 Saree Laundry — ₹150/kg\n⚡ Express available" },
      { items:["bedsheet","bed sheet","chadar"], svc:["wash","laundry"], reply:"🛏 Bedsheet Wash\nSingle — ₹150 | Double — ₹200" },
      { items:["blanket","razai","comforter"], svc:["wash","laundry"], reply:"🛌 Blanket/Comforter Wash\nSingle — ₹350 | Double — ₹450" },
      { items:["shirt","t-shirt","tshirt","top"], svc:["wash","laundry"], reply:"👕 Shirt/T-Shirt Wash & Fold — ₹80/kg\nWash & Iron — ₹110/kg" },
      // Dry clean
      { items:["saree","sari"], svc:["dry","dryclean","dc"], reply:"🥻 Saree Dry Clean\nRegular — ₹350 | Silk — ₹400 | With work — ₹450" },
      { items:["lehenga","lehnga"], svc:["dry","dryclean","dc"], reply:"💃 Lehenga Dry Clean — from ₹350" },
      { items:["suit"], svc:["dry","dryclean","dc"], reply:"👔 Suit Dry Clean\n2 Piece — ₹400 | 3 Piece — from ₹350" },
      { items:["blazer","coat"], svc:["dry","dryclean","dc"], reply:"🧥 Blazer/Coat Dry Clean — ₹300" },
      { items:["jacket"], svc:["dry","dryclean","dc"], reply:"🧥 Jacket Dry Clean — ₹250" },
      { items:["kurta","kurti"], svc:["dry","dryclean","dc"], reply:"👘 Kurta/Kurti Dry Clean — ₹100" },
      { items:["shirt","pant","trouser","jeans","tshirt","top"], svc:["dry","dryclean","dc"], reply:"👔 Shirt/Pant/Jeans/Top Dry Clean — ₹100/piece" },
      { items:["blouse"], svc:["dry","dryclean","dc"], reply:"👚 Blouse Dry Clean — ₹100 | With work — ₹120" },
      { items:["sweater","sweatshirt","woolen"], svc:["dry","dryclean","dc"], reply:"🧶 Sweater/Sweatshirt Dry Clean — from ₹200" },
      { items:["dupatta"], svc:["dry","dryclean","dc"], reply:"🧣 Dupatta Dry Clean — from ₹120" },
      { items:["curtain","parda"], svc:["dry","dryclean","dc"], reply:"🏠 Curtain Dry Clean — ₹15/sq.ft" },
      { items:["bag","purse","handbag"], svc:["dry","dryclean","dc","clean"], reply:"👜 Bag/Purse Dry Clean — from ₹200" },
      // Steam iron
      { items:["saree","sari"], svc:["iron","press","istri","steam"], reply:"🥻 Saree Steam Iron — ₹120/piece" },
      { items:["lehenga","lehnga"], svc:["iron","press","istri","steam"], reply:"💃 Lehenga Steam Iron — ₹120/piece" },
      { items:["blazer","coat"], svc:["iron","press","istri","steam"], reply:"🧥 Blazer Steam Iron — ₹120/piece" },
      { items:["kurta","kurti"], svc:["iron","press","istri","steam"], reply:"👘 Kurta Steam Iron — ₹30/piece" },
      { items:["shirt","pant","trouser","jeans"], svc:["iron","press","istri","steam"], reply:"👔 Shirt/Pant Steam Iron — ₹20/piece" },
      { items:["bedsheet","bed sheet"], svc:["iron","press","istri","steam"], reply:"🛏 Bedsheet Steam Iron — ₹60/piece" },
      // Shoes
      { items:["sneaker","canvas","white shoe"], svc:["clean","wash","shoe"], reply:"👟 Canvas/Sneaker Cleaning — ₹300/pair" },
      { items:["leather shoe","formal shoe","suede"], svc:["clean","wash","shoe"], reply:"👞 Leather/Suede Shoe Cleaning — from ₹400/pair" },
      { items:["sports shoe","running shoe"], svc:["clean","wash","shoe"], reply:"🏃 Sports Shoe Cleaning — ₹350/pair" },
      // Specialty
      { items:["helmet"], svc:["clean","wash"], reply:"🪖 Helmet Cleaning — from ₹150" },
      { items:["soft toy","teddy","stuffed toy"], svc:["clean","wash"], reply:"🧸 Soft Toy Cleaning — from ₹200" },
      { items:["carpet","rug"], svc:["clean","wash","dry"], reply:"🏠 Carpet Dry Cleaning — from ₹40/sq.ft" },
    ];

    for (const entry of ITEM_PRICE_QUICK) {
      const itemMatch = entry.items.some(i => t.includes(i));
      const svcMatch  = entry.svc.some(s => t.includes(s));
      if (itemMatch && svcMatch) {
        await send(`💰 *Price*
━━━━━━━━━━━━━━━
${entry.reply}
━━━━━━━━━━━━━━━
⚠️ Final price confirmed before cleaning

Pickup ke liye: *pickup* 🧺`);
        return;
      }
    }

    // ── Service category fallback ─────────────────────────────────
    if (has(t, "iron","press","istri"))                            { await send(RATES.iron); return; }
    if (has(t, "dry","dryclean","dry clean","dc"))                 { await send(RATES.dryclean); return; }
    if (has(t, "wash","laundry","dhulai","fold"))                  { await send(RATES.laundry); return; }
    if (has(t, "shoe","sneaker","joote","footwear"))               { await send(RATES.shoes); return; }
    if (has(t, "specialty","carpet","helmet","toy","bag clean","curtain","parda","rug","sofa"))   { await send(RATES.specialty); return; }
    await askPriceCategory(phone, phoneNumberId); return;
  }

  if (has(t, ...BOOKING_KW) || rawText === "btn_book") { await handleBookingIntent(phone, session, rawText, t, branch, phoneNumberId); return; }

  // ══ LAYER 4: Gemini ══════════════════════════════════════════════
  const customer  = await getCustomer(phone);
  const active    = await getActiveOrder(phone);
  const lastOrder = await getLastOrder(phone);
  if (customer) {
    if (!session.booking.name)    session.booking.name    = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
  }

  const ai = await geminiChat(phone, rawText, session, customer, active, lastOrder, branch);
  console.log(`[AI] action:${ai.action} reply:${ai.reply?.slice(0,60)}`);

  if (ai.extracted?.name    && !session.booking.name)    session.booking.name    = ai.extracted.name;
  if (ai.extracted?.address && !session.booking.address) session.booking.address = ai.extracted.address;
  if (ai.extracted?.date) {
    const d = ai.extracted.date;
    session.booking.date = d === "today" ? getToday() : d === "tomorrow" ? getTomorrow() : d === "day_after_tomorrow" ? getDayAfter() : d;
    if (isThursdayStr(session.booking.date)) {
      session.booking.date = null;
      await send("Thursday ko hum band rehte hain 🙏\nKoi aur din choose karein:");
      await askDate(phone, phoneNumberId); return;
    }
  }
  if (ai.extracted?.slot === "morning") session.booking.slot = "Morning (10 AM – 1 PM)";
  if (ai.extracted?.slot === "evening") session.booking.slot = "Evening (5 PM – 8 PM)";

  switch (ai.action) {
    case "book_now":
      if (active && active.status !== "cancelled") {
        await send(`Active order hai *${active.order_id}* (${STATUS_MAP[active.status]?.label}).\nCancel: *cancel* | Track: *track*`); return;
      }
      if (session.booking.name && session.booking.address && session.booking.date && session.booking.slot) {
        await confirmBooking(phone, session.booking, branch, phoneNumberId); session.booking = {};
      } else { await handleBookingIntent(phone, session, rawText, t, branch, phoneNumberId); }
      break;
    case "need_name":    session.step = "get_name";    await send(ai.reply || "Apna naam batao 😊"); break;
    case "need_address": session.step = "get_address"; await send(ai.reply || "📍 Pickup address bhejein:"); break;
    case "need_date":    if (ai.reply) await send(ai.reply); await askDate(phone, phoneNumberId); session.step = "select_date"; break;
    case "need_slot":    if (ai.reply) await send(ai.reply); await askSlot(phone, phoneNumberId); session.step = "select_slot"; break;
    case "show_rates_menu": await askPriceCategory(phone, phoneNumberId); break;
    case "show_iron":       await send(RATES.iron); break;
    case "show_dryclean":   await send(RATES.dryclean); break;
    case "show_laundry":    await send(RATES.laundry); break;
    case "show_shoes":      await send(RATES.shoes); break;
    case "track_order":
      if (active) {
        const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
        const del = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
        await send(`📦 *Aapka Order*\n\n🆔 ${active.order_id}\n${s.label}${del}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
      } else { await send(ai.reply || "Koi active order nahi. *pickup* type karein 🧺"); }
      break;
    case "complaint":
      await send(ai.reply || "Bahut sorry 🙏 Admin se contact ho jayega.");
      await notifyAdminComplaint(phone, customer?.name, rawText, branch, phoneNumberId); break;
    case "estimate": {
      let items = ai.extracted?.items?.length ? ai.extracted.items : extractEstimateItems(rawText);
      if (items.length > 0) {
        const { total, breakdown, unknown } = calcEstimate(items);
        if (total > 0) {
          let msg = `💰 *Estimate*\n━━━━━━━━━━━━━━━\n`;
          breakdown.forEach(l => msg += `${l}\n`);
          if (unknown.length) msg += `\n⚠️ Estimate nahi mila: ${unknown.join(", ")}\n`;
          msg += `━━━━━━━━━━━━━━━\n*Total: ₹${total}*\n⚡ Express (4–8hr): ₹${Math.ceil(total*1.5)}\n\n_Final bill may vary_\n\nPickup ke liye: *pickup* 🧺`;
          await send(msg);
        } else { await send(ai.reply || "Items aur service batao 😊"); }
      } else {
        // No items found — check if they just gave item count with no service
        const numMatch = rawText.match(/(\d+)\s*(kapde|clothes|shirts?|pants?|sarees?)/i);
        if (numMatch) {
          await sendBtn(`Kaunsi service chahiye? 😊`,
            [{ id:"price_dc", title:"🧥 Dry Clean" }, { id:"price_iron", title:"🔥 Steam Iron" }, { id:"price_wash", title:"🫧 Laundry" }]
          );
        } else {
          await send(ai.reply || "e.g. *3 shirt dry clean, 2 saree iron* 😊");
        }
      }
      break;
    }
    default:
      if (ai.reply) { await send(ai.reply); }
      else if (customer) { await send(`${customer.name} ji! 👋\n\n*pickup* — booking\n*rates* — prices\n*track* — order status`); }
      else { await sendBtn(`Hi! 👋 Washkart ${branch.name} mein aapka swagat hai!`,
        [{ id:"btn_book", title:"📦 Book Pickup" }, { id:"btn_price", title:"💰 Rates" }, { id:"btn_track", title:"🔍 Track Order" }]); }
  }
  if (ai.reply) session.history.push({ role: "bot", text: ai.reply });
  saveSession(phone, session);
}

// ── PAYMENT HANDLER ───────────────────────────────────────────────
async function handlePayment(phone, session, branch, phoneNumberId) {
  const active   = await getActiveOrder(phone);
  const customer = await getCustomer(phone);
  const send     = (msg) => sendMessage(phone, msg, phoneNumberId);
  const sendBtn  = (msg, btns) => sendButtons(phone, msg, btns, phoneNumberId);

  if (!active) {
    await send("Koi active order nahi mila. 😊 Agar payment ho gayi to admin se confirm karwa lena.");
    return;
  }
  if (active.payment_status === "paid") {
    await send(`✅ Order *${active.order_id}* ka payment already confirmed hai! 🙏`);
    return;
  }
  session.paymentOrderId = active.order_id;
  session.paymentAmount  = active.amount || 0;
  session.step = "payment_method";
  saveSession(phone, session);
  await sendBtn(
    `🙏 Payment receive hua!\n\n🆔 ${active.order_id}${active.amount ? `\n💰 ₹${active.amount}` : ""}\n\nKaunse method se payment kiya?`,
    [{ id:"pay_upi", title:"📱 UPI / QR" }, { id:"pay_cash", title:"💵 Cash" }]
  );
}

// ── FLOW HELPERS ──────────────────────────────────────────────────
async function handleDateButton(phone, session, which, phoneNumberId) {
  if (which === "today") {
    if (isTodayThursday()) { await sendMessage(phone, "Aaj Thursday hai — hum band 🙏", phoneNumberId); await askDate(phone, phoneNumberId); return; }
    session.booking.date = getToday();
  } else {
    if (isTomorrowThursday()) { await sendMessage(phone, "Kal Thursday hai — hum band 🙏", phoneNumberId); await askDate(phone, phoneNumberId); return; }
    session.booking.date = getTomorrow();
  }
  session.step = "select_slot"; saveSession(phone, session);
  await askSlot(phone, phoneNumberId);
}
async function handleSlotSelected(phone, session, phoneNumberId) {
  session.step = "idle";
  const bk = session.booking;
  console.log(`[slotSelected] name:${bk.name} address:${bk.address} date:${bk.date} slot:${bk.slot}`);

  // Load customer data if name/address missing
  if (!bk.name || !bk.address) {
    const customer = await getCustomer(phone);
    if (customer) {
      if (!bk.name)    bk.name    = customer.name;
      if (!bk.address) bk.address = customer.address;
    }
  }

  if (bk.name && bk.address && bk.date && bk.slot) {
    await showBookingConfirm(phone, session, phoneNumberId);
  } else if (!bk.date) {
    await askDate(phone, phoneNumberId);
    session.step = "select_date";
  } else if (!bk.name) {
    await sendMessage(phone, "Apna naam batao 😊", phoneNumberId);
    session.step = "get_name";
  } else if (!bk.address) {
    await sendMessage(phone, "📍 Apna pickup address bhejein:", phoneNumberId);
    session.step = "get_address";
  } else {
    // All data present but something still missing — force confirm
    console.log(`[slotSelected] fallback — forcing confirm`);
    await showBookingConfirm(phone, session, phoneNumberId);
  }
  saveSession(phone, session);
}
async function handleTrack(phone, session, rawText, phoneNumberId) {
  const send = (msg) => sendMessage(phone, msg, phoneNumberId);
  if (rawText) {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings", `order_id=eq.${m[0].toUpperCase()}`).catch(()=>[]);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
        const del = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
        await send(`📦 *${rows[0].order_id}*\n${s.label}${del}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        return;
      }
    }
  }
  const active = await getActiveOrder(phone);
  if (active) {
    const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
    const del = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
    await send(`📦 *Aapka Order*\n\n🆔 ${active.order_id}\n${s.label}${del}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
    return;
  }
  session.step = "tracking"; saveSession(phone, session);
  await send("🔍 Apna Order ID share karein (e.g. *FW-1234*):"); return;
}
async function handleCancel(phone, session, rawText, branch, phoneNumberId) {
  const send = (msg) => sendMessage(phone, msg, phoneNumberId);
  const m = rawText.match(/FW-\d+/i);
  const active = await getActiveOrder(phone);
  const orderId = m ? m[0].toUpperCase() : active?.order_id;
  if (!orderId) { session.step = "idle"; saveSession(phone, session); await send("Koi active order nahi mila. *pickup* type karein 🧺"); return; }
  try {
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    if (!rows.length) { await send("Order nahi mila."); return; }
    if (["delivered","cancelled"].includes(rows[0].status)) { await send(`Order *${orderId}* already ${STATUS_MAP[rows[0].status]?.label} hai.`); return; }
    await sendButtons(phone, `Cancel karein *${orderId}*?\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`,
      [{ id:`cc_${orderId}`, title:"✅ Yes, Cancel" }, { id:"no_cancel", title:"❌ Keep it" }], phoneNumberId
    );
    session.step = "confirm_cancel"; saveSession(phone, session);
  } catch { await send("Kuch problem aayi. Phir try karein."); }
}
async function handleExpress(phone, branch, phoneNumberId) {
  const send = (msg) => sendMessage(phone, msg, phoneNumberId);
  const active = await getActiveOrder(phone);
  if (active?.status === "picked" || active?.status === "inprogress") {
    if (isTodayThursday()) { await send("Thursday ko express nahi hai 🙏"); return; }
    await dbUpdate("bookings", `order_id=eq.${active.order_id}`, { express: true });
    await send(`⚡ *Express Confirmed!*\n\n4–8 hours mein deliver! 🙌\n💰 1.5x charges at delivery.\n\n🆔 ${active.order_id}`);
    await sendMessage(branch.admin, `⚡ *Express!*\n🆔 ${active.order_id}\n👤 ${active.name}\n📱 +${active.phone}`, phoneNumberId);
    return;
  }
  if (active) {
    await send(`Express abhi available nahi hai 😊\nOrder status: ${STATUS_MAP[active.status]?.label}\n\nPickup ke baad ya cleaning ke dauran request karein.`);
    return;
  }
  await send("Express pickup ke baad request hota hai. Pehle *pickup* book karein 🧺");
}
async function handleSameAsLast(phone, session, phoneNumberId) {
  const send    = (msg)       => sendMessage(phone, msg, phoneNumberId);
  const sendBtn = (msg, btns) => sendButtons(phone, msg, btns, phoneNumberId);
  const customer = await getCustomer(phone);
  const last     = await getLastOrder(phone);
  const active   = await getActiveOrder(phone);
  if (active && active.status !== "cancelled") { await send(`Order *${active.order_id}* already active hai. Pehle deliver hone do! 😊`); return; }
  if (!last) { await send("Koi purana order nahi mila. *pickup* type karein! 🧺"); return; }
  session.booking.name    = customer?.name || last.name;
  session.booking.address = last.address;
  saveSession(phone, session);
  await sendBtn(`Same as last time! 🔄\n\n📍 ${last.address}\n\nKis din pickup karein?`,
    [{ id:"date_today", title:"📅 Today" }, { id:"date_tomorrow", title:"📅 Tomorrow" }, { id:"date_custom", title:"📆 Other date" }]
  );
  session.step = "select_date"; saveSession(phone, session);
}
async function handleBookingIntent(phone, session, rawText, t, branch, phoneNumberId) {
  const send    = (msg)       => sendMessage(phone, msg, phoneNumberId);
  const sendBtn = (msg, btns) => sendButtons(phone, msg, btns, phoneNumberId);
  const customer = await getCustomer(phone);
  const active   = await getActiveOrder(phone);
  if (active && active.status !== "cancelled") {
    await send(`Order *${active.order_id}* already active (${STATUS_MAP[active.status]?.label}).\nCancel: *cancel* | Track: *track*`); return;
  }
  if (customer) {
    if (!session.booking.name)    session.booking.name    = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
  }

  const hasTomorrow = has(t, "kal ","tomorrow","kal ko","next day","udya","उद्या");
  const hasToday    = has(t, "aaj ","today","abhi","aaj ko","aajach","आज");
  const hasParso    = has(t, "parso","परवा","day after tomorrow","day after","parsoon");
  const hasMorning  = has(t, "subah","morning","savere","subeh","10 am","11 am","sakali","sakal","सकाळी","सुबह");
  const hasEvening  = has(t, "shaam","evening","sham","5 pm","6 pm","7 pm","sandhyakal","संध्याकाळी","शाम");

  const DAY_NAMES = {
    sunday:0, ravivar:0, aaditwar:0, adiwar:0,
    monday:1, somwar:1, somavar:1,
    tuesday:2, mangalwar:2, mangalavar:2,
    wednesday:3, budhwar:3, budhavar:3,
    thursday:4, guruvar:4, bruhaspativar:4,
    friday:5, shukrawar:5, shukravar:5,
    saturday:6, shaniwar:6, shanivar:6, shanivari:6,
  };
  function getNextDayDate(targetDay) {
    const d = new Date();
    const diff = (targetDay - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return formatDate(d);
  }
  let detectedDayName = null;
  for (const [name, dayNum] of Object.entries(DAY_NAMES)) {
    if (t.includes(name)) { detectedDayName = dayNum; break; }
  }

  if (hasParso) {
    session.booking.date = getDayAfter();
  } else if (hasTomorrow) {
    if (isTomorrowThursday()) { await send("Kal Thursday hai — hum band 🙏\nKoi aur din?"); await askDate(phone, phoneNumberId); return; }
    session.booking.date = getTomorrow();
  } else if (hasToday) {
    if (isTodayThursday()) { await send("Aaj Thursday hai — hum band 🙏\nKoi aur din?"); await askDate(phone, phoneNumberId); return; }
    session.booking.date = getToday();
  } else if (detectedDayName !== null) {
    if (detectedDayName === 4) { await send("Thursday ko hum band rehte hain 🙏\nKoi aur din batao:"); await askDate(phone, phoneNumberId); return; }
    session.booking.date = getNextDayDate(detectedDayName);
  }

  if (hasMorning)      session.booking.slot = "Morning (10 AM – 1 PM)";
  else if (hasEvening) session.booking.slot = "Evening (5 PM – 8 PM)";

  const bk = session.booking;
  if (customer && bk.name && bk.address && bk.date && bk.slot) { await showBookingConfirm(phone, session, phoneNumberId); return; }
  if (bk.date && !bk.slot) { await askSlot(phone, phoneNumberId); session.step = "select_slot"; saveSession(phone, session); return; }
  if (!bk.date && bk.slot) { await askDate(phone, phoneNumberId); session.step = "select_date"; saveSession(phone, session); return; }
  if (customer && bk.name && bk.address) {
    await sendBtn(`Pickup book karein? 😊\n\n📍 ${customer.address}`,
      [{ id:"use_saved", title:"✅ Yes, this address" }, { id:"update_details", title:"✏️ New address" }]
    );
    session.step = "confirm_details"; saveSession(phone, session); return;
  }
  if (!bk.name)    { await send(`👋 Welcome to *Washkart ${branch.name}*! 🧺\n\nApna naam batao:`); session.step = "get_name"; saveSession(phone, session); return; }
  if (!bk.address) { await send(`📍 ${bk.name} ji, apna pickup address bhejein:`); session.step = "get_address"; saveSession(phone, session); return; }
  await askDate(phone, phoneNumberId); session.step = "select_date"; saveSession(phone, session);
}

// ── REMINDERS ─────────────────────────────────────────────────────
async function sendReminders() {
  try {
    const today = getToday();
    const rows  = await dbSelect("bookings", `date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const hour  = new Date().getHours();
    for (const b of rows) {
      if ((b.slot?.includes("Morning") && hour === 8) || (b.slot?.includes("Evening") && hour === 15)) {
        const br  = Object.values(BRANCHES).find(x => x.slug === b.branch) || DEFAULT_BRANCH;
        const numId = Object.keys(BRANCHES).find(k => BRANCHES[k].slug === b.branch) || "1136879376186203";
        await sendMessage(b.phone, `⏰ *Pickup Reminder!*\n\nHi ${b.name}! Aaj Washkart ${br.name} pickup hai.\n\n🕐 ${b.slot}\n📍 ${b.address}\n🆔 ${b.order_id}\n\nCancel: *cancel*`, numId);
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
    const entry   = req.body.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const messages = value?.messages;
    const phoneNumberId = value?.metadata?.phone_number_id || "1136879376186203";
    if (!messages?.length) return res.sendStatus(200);
    const msg = messages[0];
    if (processedMessages.has(msg.id)) return res.sendStatus(200);
    processedMessages.add(msg.id);
    setTimeout(() => processedMessages.delete(msg.id), 60000);
    const phone = normalizePhone(msg.from);
    if (msg.type === "audio")    { await handleMessage(phone, "__audio__",    phoneNumberId); return res.sendStatus(200); }
    if (msg.type === "image")    { await handleMessage(phone, "__image__",    phoneNumberId); return res.sendStatus(200); }
    if (msg.type === "video")    { await handleMessage(phone, "__video__",    phoneNumberId); return res.sendStatus(200); }
    if (msg.type === "document") { await handleMessage(phone, "__document__", phoneNumberId); return res.sendStatus(200); }
    if (msg.type === "sticker")  { await handleMessage(phone, "__sticker__",  phoneNumberId); return res.sendStatus(200); }
    let text = "";
    if (msg.type === "text") text = msg.text.body;
    else if (msg.type === "interactive") {
      text = msg.interactive.type === "button_reply" ? msg.interactive.button_reply.id : msg.interactive.list_reply.id;
    }
    if (text) await handleMessage(phone, text, phoneNumberId);
    res.sendStatus(200);
  } catch (err) { console.error(err?.response?.data || err.message); res.sendStatus(200); }
});

// ── DASHBOARD API ─────────────────────────────────────────────────
app.get("/bookings", async (req, res) => {
  try {
    const { branch, phone } = req.query;
    const filters = ["order=created_at.desc"];
    if (branch && branch !== "all") filters.push(`branch=eq.${branch}`);
    if (phone) filters.push(`phone=eq.${normalizePhone(phone)}`);
    res.json(await dbSelect("bookings", filters.join("&")));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/bookings", async (req, res) => {
  try {
    const { name, phone, address, date, slot, source, notes, service_type, branch } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
    const isWalkIn = source === "walkin";
    if (!isWalkIn && (!address || !date || !slot)) return res.status(400).json({ error: "Missing required fields: address, date, slot" });
    const orderId    = genOrderId();
    const normPhone  = normalizePhone(phone);
    const branchSlug = branch || "bavdhan";
    const br         = Object.values(BRANCHES).find(x => x.slug === branchSlug) || DEFAULT_BRANCH;
    const numId      = Object.keys(BRANCHES).find(k => BRANCHES[k].slug === branchSlug) || "1136879376186203";
    await dbInsert("bookings", {
      order_id: orderId, name, phone: normPhone,
      address: address || "Walk-in (In-store)",
      date: date || getToday(), slot: slot || "Walk-in",
      status: isWalkIn ? "picked" : "pending",
      reminder_sent: false, source: source || "walkin",
      branch: branchSlug, notes: notes || "",
      amount: 0, payment_status: "unpaid", payment_method: "",
      ...(service_type ? { service_type } : {}),
    });
    if (address) await saveCustomer(normPhone, name, address, branchSlug);
    else {
      const existing = await getCustomer(normPhone);
      if (!existing) await dbInsert("customers", { phone: normPhone, name, address: "", branch: branchSlug }).catch(()=>{});
    }
    await sendMessage(br.admin,
      `🔔 *New Booking [${source||"Walk-in"}]* [${br.name}]\n\n🆔 ${orderId}\n👤 ${name}\n📱 +${normPhone}\n📍 ${address||"Walk-in"}\n📅 ${date||getToday()}\n🕐 ${slot||"Walk-in"}${notes?`\n📝 ${notes}`:""}${service_type?`\n🧺 ${service_type}`:""}`,
      numId
    );
    res.json({ success: true, order_id: orderId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/bookings/:orderId", async (req, res) => {
  try {
    const { status, service_type, express, delivery_date, notes, amount, payment_status, payment_method } = req.body;
    const orderId    = req.params.orderId;
    const updateData = { status };
    if (service_type     !== undefined) updateData.service_type    = service_type;
    if (express          !== undefined) updateData.express          = express;
    if (delivery_date)                  updateData.delivery_date    = delivery_date;
    if (notes            !== undefined) updateData.notes            = notes;
    if (amount           !== undefined) updateData.amount           = amount;
    if (payment_status   !== undefined) updateData.payment_status   = payment_status;
    if (payment_method   !== undefined) updateData.payment_method   = payment_method;
    if (payment_status === "paid")      updateData.payment_date     = new Date().toISOString();
    if (service_type && !delivery_date) updateData.delivery_date    = calcDeliveryDate(service_type, express || false);
    await dbUpdate("bookings", `order_id=eq.${orderId}`, updateData);
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    const b    = rows[0];
    const branchSlug = b?.branch || "bavdhan";
    const br   = Object.values(BRANCHES).find(x => x.slug === branchSlug) || DEFAULT_BRANCH;
    const numId = Object.keys(BRANCHES).find(k => BRANCHES[k].slug === branchSlug) || "1136879376186203";

    const amountLine = b?.amount ? `\n💰 Bill: ₹${b.amount}\n💳 Payment via UPI QR / Cash` : "";
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
      outfordelivery:
        `🚚 *Aapka order delivery pe hai!*\n\nFresh kapde jald pahunchenge! 😊${amountLine}\n\n🆔 ${orderId}`,
      delivered:
        `✅ *Kapde deliver ho gaye!*\n\nThank you for choosing Washkart ${br.name}! 🙏${amountLine}\n\nPayment ho gayi ho to reply karein: *paid*`,
    };
    if (msgs[status] && b?.phone) {
      await sendMessage(b.phone, msgs[status], numId);
      if (status === "delivered") {
        setTimeout(async () => {
          await sendButtons(b.phone,
            "Aapka experience kaisa raha? 😊",
            [{ id:"rating_excellent", title:"🤩 Excellent" }, { id:"rating_good", title:"😊 Good" }, { id:"rating_poor", title:"😞 Needs Work" }],
            numId
          );
          sessionCache[b.phone] = sessionCache[b.phone] || { step:"idle", booking:{}, history:[] };
          sessionCache[b.phone].step = "feedback";
          saveSession(b.phone, sessionCache[b.phone]);
        }, 2000);
      }
    }

    // Manual payment reminder from dashboard
    if (req.body.send_payment_reminder && b?.phone && b?.amount) {
      await sendMessage(b.phone,
        `💰 *Payment Reminder*\n\nHi ${b.name} ji! Washkart ${br.name} order *${orderId}* ka payment pending hai.\n\n💵 Amount: ₹${b.amount}\n💳 UPI QR se payment karein ya cash dein.\n\nPayment ho gayi? Reply: *paid* 🙏`,
        numId
      );
    }

    res.json({ success: true, delivery_date: updateData.delivery_date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/bookings/:orderId", async (req, res) => {
  try { await dbDelete("bookings", `order_id=eq.${req.params.orderId}`); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/send-message", async (req, res) => {
  try {
    const { phone, message, branch } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "Phone and message required" });
    const normalized = normalizePhone(phone);
    const branchSlug = branch || "bavdhan";
    const numId = Object.keys(BRANCHES).find(k => BRANCHES[k].slug === branchSlug) || "1136879376186203";
    console.log(`[send-message] raw:${phone} normalized:${normalized} branch:${branchSlug}`);
    await sendMessage(normalized, message, numId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/customers", async (req, res) => {
  try {
    const branch = req.query.branch;
    const filter = branch && branch !== "all" ? `branch=eq.${branch}&order=created_at.desc` : "order=created_at.desc";
    res.json(await dbSelect("customers", filter));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/ratings", async (req, res) => {
  try {
    const branch = req.query.branch;
    const filter = branch && branch !== "all" ? `branch=eq.${branch}&order=created_at.desc` : "order=created_at.desc";
    res.json(await dbSelect("ratings", filter));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/ping",      (req, res) => res.json({ status:"ok", time: new Date().toISOString() }));
app.get("/",          (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart Bot running on port ${PORT} 🧺`));
