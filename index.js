const express = require("express");
const axios   = require("axios");
const path    = require("path");
const app     = express();
app.use(express.json());

// CORS
const ALLOWED_ORIGINS = [
  "https://www.washkart.co.in",
  "https://washkart.co.in",
  "https://super-glade-8ea3.bhavin2267.workers.dev"
];
app.use((req, res, next) => {
  if (ALLOWED_ORIGINS.includes(req.headers.origin)) {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// BRANCH CONFIG
const BRANCHES = {
  "1136879376186203": { name: "Bavdhan", slug: "bavdhan", admin: "917775066002", upi: "washkart@idfcbank", qrMediaId: null },
  "BANER_NUMBER_ID":  { name: "Baner",   slug: "baner",   admin: "918888266265", upi: "337724609223803@cnrb", qrMediaId: null },
};
const DEFAULT_BRANCH = BRANCHES["1136879376186203"];
function getBranch(phoneNumberId) { return BRANCHES[phoneNumberId] || DEFAULT_BRANCH; }
function getBranchBySlug(slug) { return Object.values(BRANCHES).find(b => b.slug === slug) || null; }
function getBranchNumId(slug) { return Object.keys(BRANCHES).find(k => BRANCHES[k].slug === slug) || "1136879376186203"; }

const AREA_BRANCH = {
  bavdhan: ["bavdhan","warje","kothrud","chandani","dsk","salisbury","bhugaon","paud"],
  baner:   ["baner","balewadi","aundh","pashan","wakad","hinjewadi","sus","mahalunge"],
};
function detectBranchFromAddress(address) {
  if (!address) return null;
  const a = address.toLowerCase();
  for (const [slug, kws] of Object.entries(AREA_BRANCH)) {
    if (kws.some(k => a.includes(k))) return slug;
  }
  return null;
}

// CONFIG
const TOKEN        = process.env.WHATSAPP_TOKEN;
const OWNER_NUMBER = "919552552167"; // Owner gets all alerts regardless of branch
const VERIFY_TOKEN = "washkart_verify_123";
const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DB           = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS   = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

// DB CORE
async function dbInsert(t, d) { return (await axios.post(`${DB}/${t}`, d, { headers: SB_HEADERS })).data; }
async function dbSelect(t, f) { return (await axios.get(`${DB}/${t}?${f}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(t, f, d) { return (await axios.patch(`${DB}/${t}?${f}`, d, { headers: SB_HEADERS })).data; }
async function dbDelete(t, f) { return (await axios.delete(`${DB}/${t}?${f}`, { headers: { ...SB_HEADERS, Prefer: "" } })).data; }

// SESSIONS
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
    if (rows && rows.length) {
      const s = rows[0];
      sessionCache[phone] = {
        step: s.step || "idle",
        booking: typeof s.booking === 'object' ? (s.booking || {}) : {},
        history: Array.isArray(s.history) ? s.history : [],
      };
    } else {
      sessionCache[phone] = { step: "idle", booking: {}, history: [] };
    }
  } catch (e) {
    console.log(`[session] getSession fallback for ${phone}: ${e.message}`);
    sessionCache[phone] = { step: "idle", booking: {}, history: [] };
  }
  return sessionCache[phone];
}

const sessionWriteTimers = {};
function saveSession(phone, session) {
  sessionCache[phone] = session;
  if (sessionWriteTimers[phone]) clearTimeout(sessionWriteTimers[phone]);
  sessionWriteTimers[phone] = setTimeout(async () => {
    try {
      const rows = await dbSelect("sessions", `phone=eq.${phone}`).catch(() => []);
      const payload = { phone, step: session.step || "idle", booking: session.booking || {}, history: (session.history || []).slice(-12), updated_at: new Date().toISOString() };
      if (rows.length) await dbUpdate("sessions", `phone=eq.${phone}`, payload);
      else             await dbInsert("sessions", payload);
    } catch (e) { console.log(`[session] skipped: ${e.message}`); }
  }, 2000);
}

// MESSAGE QUEUE
const messageQueues = {};
function enqueueMessage(phone, rawText, phoneNumberId) {
  if (!messageQueues[phone]) messageQueues[phone] = Promise.resolve();
  messageQueues[phone] = messageQueues[phone]
    .then(() => handleMessage(phone, rawText, phoneNumberId))
    .catch(e => {
      console.error(`[queue error] ${phone}: ${e.message}`);
      // Reset queue on error so subsequent messages still process
      messageQueues[phone] = Promise.resolve();
    });
}

// RATE LIMITING
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

// BLOCKED NUMBERS
const blockedNumbers = new Set();

// DATE UTILS
function formatDate(d) { return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getToday()    { return formatDate(new Date()); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return formatDate(d); }
function getDayAfter() { const d = new Date(); d.setDate(d.getDate() + 2); return formatDate(d); }
function isTodayThursday()    { return new Date().getDay() === 4; }
function isTomorrowThursday() { const d = new Date(); d.setDate(d.getDate() + 1); return d.getDay() === 4; }
function isThursdayStr(str) {
  if (!str) return false;
  const s = str.toLowerCase();
  if (s.includes("thursday") || s.includes("guruvar") || s.includes("veervar") || s.includes("guruvaar") || s.includes("bruhaspativar")) return true;
  try { const d = new Date(str); if (!isNaN(d.getTime()) && d.getDay() === 4) return true; } catch {}
  return false;
}
function calcDeliveryDate(service, isExpress) {
  const hours = { iron: isExpress ? 2 : 36, laundry: isExpress ? 2 : 72, dryclean: isExpress ? 2 : 96, shoes: isExpress ? 2 : 48, mixed: isExpress ? 2 : 96, specialty: isExpress ? 2 : 72 };
  const d = new Date();
  d.setHours(d.getHours() + (hours[service] || 72));
  if (d.getDay() === 4) d.setDate(d.getDate() + 1);
  return formatDate(d);
}
function genOrderId() { return `FW-${Date.now().toString().slice(-4)}${Math.floor(100 + Math.random() * 900)}`; }

// SEND HELPERS
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMessage(to, text, phoneNumberId, throwOnError=false) {
  const numId = phoneNumberId || "1136879376186203";
  try {
    const res = await axios.post(`https://graph.facebook.com/v25.0/${numId}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[msg] to:${to} status:${res.status}`);
    return true;
  } catch (e) {
    const errData = e?.response?.data;
    const errMsg = errData ? JSON.stringify(errData) : e.message;
    console.error(`[msg error] to:${to} numId:${numId}:`, errMsg);
    if (throwOnError) throw new Error(errMsg);
    return false;
  }
}

async function sendButtons(to, body, buttons, phoneNumberId) {
  const numId = phoneNumberId || "1136879376186203";
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${numId}/messages`,
      { messaging_product: "whatsapp", to, type: "interactive",
        interactive: { type: "button", body: { text: body },
          action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("sendButtons error:", e?.response?.data || e.message); }
}

async function sendImage(to, mediaId, caption, phoneNumberId) {
  const numId = phoneNumberId || "1136879376186203";
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${numId}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { id: mediaId, caption: caption || "" } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("sendImage error:", e?.response?.data || e.message); }
}

// TEXT HELPERS
function norm(t) { return t.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " "); }
function has(t, ...words) {
  return words.some(w => {
    if (w.length <= 3) {
      const regex = new RegExp(`(?:^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
      return regex.test(t);
    }
    return t.includes(w);
  });
}

// KEYWORD GROUPS
const BOOKING_KW = [
  "pickup","pick up","book","schedule","collect","collection","booking","new order","want pickup","need pickup","laundry pickup",
  "kapde dene","kapde lene","kapde bhejo","kapde uthao","ghar se lelo","ghar aao","ghar pe aao",
  "pickup karna","pickup chahiye","pickup karo","mujhe pickup","book karo","booking karo","booking chahiye","order karo",
  "laundry dena","laundry lena","laundry chahiye","dhulai karo","istri karo","press karo","dhona hai",
  "pickup hava","pickup kara","pickup dyaa","kapde nyaa","kapde ghya","ghari ya","booking kara","laundry dyaa","laundry kara",
  "pickup book karna hai","kapde collect karo","kapde le jao","wash karna hai","dry clean karna hai",
  "parso","parso subah","parso shaam","service chahiye","laundry service","cleaning chahiye",
];
const TRACK_KW = [
  "track","tracking","order status","check order","status","delivery status","where are my clothes",
  "kahan hai","kab aayega","kab milega","delivery kab","order kahan","kapde kahan","mera order",
  "status batao","kab tak aayega","order hua kya","kapde aaye kya",
  "status sanga","kapde aale ka",
  "order track karo","kapde kab aayenge",
  "ready hue","ready hai","tayar hue","order ready","ready ho gaya","tayar zale",
  "kab milega","kab aayega","kab tak aayega","kab deliver",
];
const RESCHEDULE_KW = [
  "reschedule","change date","change slot","change pickup","change timing",
  "reschedule karo","date change karo","time change karo","slot change karo",
  "reschedule kara","date badlaycha","वेळ बदला","तारीख बदला",
  "postpone","delay pickup","shift pickup",
];
const CANCEL_KW = [
  "cancel","cancellation","cancel order","cancel booking",
  "band karo","nahi chahiye","cancel karo","booking cancel","order cancel","cancel karna",
  "rehne do","band kar do","cancel kar do",
  "cancel kara","nako","radhd kara","booking nako","order nako",
];
const EXPRESS_KW = [
  "express","urgent","fast","quick","asap","rush","same day","4 hour","emergency","immediately",
  "jaldi","jaldi karo","jaldi chahiye","urgent hai","express chahiye","abhi chahiye",
  "lavkar","lavkar kara","urgent aahe","express hava",
  "express lagao","jaldi bhai","fast kar do",
];
const HELP_KW = [
  "help","menu","options","what can you do","commands","guide","services","how does it work","info",
  "kya kar sakte","kya karte ho","madad chahiye","help chahiye","help kara","madat kara",
];
const YES_KW = [
  "yes","yep","yup","yeah","sure","correct","confirm","alright","absolutely","proceed","go ahead",
  "haan","ha","haa","ji","theek","sahi","bilkul","zaroor","ho ja","kar do","haan ji",
  "ho","hoy","barobar","nakkicha",
];
const NO_KW = [
  "no","nope","nah","not now","later",
  "nahi","na","nhi","nahin","nai","naa","abhi nahi","rehne do",
  "nako","nakos",
];
const SAME_KW = [
  "same as last","same as before","same as last time","repeat","repeat order","same order","last order again",
  "pichli baar jaisa","last wala","wahi wala","pehle wala","same karo",
  "aaglyasarkha","tyach sarkha","same kara",
];
const RATES_KW = [
  "rate card","price list","rates","price","pricing","charges","cost","fee","tariff",
  "how much","what is the price","what are the charges",
  "kitna lagta","kitne paise","kitna chahiye","kitna hoga","kitne mein","rate kya hai","price kya hai",
  "kya rate","daam kya","price batao","charge batao",
  "kiti lagel","kiti paisa","rate kiti","kiti rupaye","rate sanga","price sanga",
  "dryclean ka","dry clean ka","iron ka","press ka","wash ka","laundry ka","clean ka","shoe ka",
  "dryclean chi","press chi","istri chi","wash chi",
  "kitna lagega","kitna padega","cost kitna","lagega kitna","price of","cost of","charge for","rate for",
];
const GREET_KW = [
  "hi","hello","hey","hii","heya","good morning","good evening","good afternoon","good night","sup","wassup",
  "namaste","namaskar","pranam","salaam","salam","kya haal","kaise ho",
  "kasa aahe","kase aahat",
];
const PAYMENT_KW = [
  "paid","payment done","payment kar diya","pay kar diya","paisa diya","upi done","gpay done","phonepe done",
  "payment kela","paisa dila","pay kela","paid bhai","payment ho gaya",
];
const THANKS_KW = [
  "thank you","thanks","thankyou","thank u","thx","ty",
  "shukriya","dhanyawad","bahut shukriya","accha","acha","achha",
];
const RESET_KW = [
  "start over","start again","reset","restart","shuru se","phir se shuru","dobara",
  "forget it","forget everything","clear","cancel everything","fresh start","begin again",
];
const WRONG_NUMBER_KW = [
  "wrong number","galat number","who are you","kaun ho","kya hai ye","ye kaun hai","wrong","galat",
];
const LOCATION_KW = [
  "location","address","where are you","kahan ho","shop kahan","store kahan","dukan kahan",
  "kuth aahe","address sanga",
];
const WEBSITE_KW = [
  "website","site","instagram","insta","web","www","washkart.co.in","_washkart_",
];
const DELIVERY_TIME_KW = [
  "how long","kitna time","delivery time","kitne din","kab ready","kab deliver","when will","time lagega",
  "kiti vel","kev milel","kev tayar",
];
const BULK_KW = [
  "bulk","large order","bahut saare","bohot kapde","zyada kapde","bulk order",
  "office laundry","hotel laundry","hostel laundry","commercial",
];
const ORDER_READY_KW = [
  "ready hua","kapde ready","tayar hua","order complete","complete hua","clean hua",
];
const COMPLAINT_KW = [
  "complaint","problem","issue","damaged","torn","missing","khrab","kharab","kapda kharab",
  "ganda aaya","dhang se nahi","poor service","bad service","disappointed","worst","cheating","fraud",
];
const OPERATING_HOURS_KW = [
  "open","closed","timing","hours","kab khulte","kab band","opening time","closing time","timings",
];
const AVAIL_KW = [
  "kya aap","karte ho","karte hain","milti hai","hoti hai","available","karta ho","karta hai",
  "do you","can you","hoga","hote hain","ho sakta","ho sakti","hai kya","milega kya","hota hai",
];

// STATUS CONFIG
const STATUS_MAP = {
  pending:        { label: "Pending Pickup",      eta: "We will pick up within your selected slot." },
  picked:         { label: "Picked Up",           eta: "Clothes picked up. Cleaning starts soon." },
  inprogress:     { label: "In Progress",         eta: "Your clothes are being carefully cleaned." },
  outfordelivery: { label: "Out for Delivery",    eta: "Your clothes are on the way." },
  delivered:      { label: "Delivered",           eta: "Thank you for choosing Washkart!" },
  cancelled:      { label: "Cancelled",           eta: "This order was cancelled." },
};

// RATES
const RATES = {
  iron:
    "Steam Iron Rates\n" +
    "Normal clothes - Rs 20/piece\n" +
    "Kurta (Men) - Rs 30/piece\n" +
    "Anarkali / Shawl - Rs 50/piece\n" +
    "Bedsheet - Rs 60/piece\n" +
    "Saree / Blazer / Lehenga - Rs 120/piece\n\n" +
    "Final price confirmed before cleaning starts.",
  dryclean:
    "Dry Cleaning Rates\n\n" +
    "Shirt / T-Shirt / Top / Pant - Rs 100\n" +
    "Blouse / Salwar - Rs 100\n" +
    "Blouse (with work) - Rs 120\n" +
    "Dupatta - from Rs 120\n" +
    "Sweater / Sweatshirt - from Rs 200\n" +
    "Jacket - Rs 250\n" +
    "Overcoat - Rs 400\n" +
    "Coat / Blazer - Rs 300\n" +
    "Suit (2 piece) - Rs 400\n" +
    "Saree - from Rs 350\n" +
    "Saree (Silk) - Rs 400\n" +
    "Saree (with work) - Rs 450\n" +
    "Lehenga - from Rs 350\n" +
    "Bags / Handbags - from Rs 200\n" +
    "Curtains - Rs 15/sq.ft | Towel - Rs 150\n\n" +
    "Final price confirmed before cleaning starts.",
  laundry:
    "Laundry Rates\n\n" +
    "Wash and Fold - Rs 80/kg\n" +
    "Wash and Iron - Rs 110/kg\n" +
    "Express Wash (90 min) - Rs 120/kg\n" +
    "Express Wash and Iron (90 min) - Rs 160/kg\n\n" +
    "Bedsheet Single - Rs 150 | Double - Rs 200\n" +
    "Blanket Single - Rs 350 | Double - Rs 450\n\n" +
    "Minimum 1 kg. Free pickup above Rs 300.",
  shoes:
    "Shoe Cleaning\n\n" +
    "Canvas Shoes - Rs 300/pair\n" +
    "Sneakers / Sports - Rs 350/pair\n" +
    "Suede / Leather - from Rs 400/pair\n\n" +
    "Final price confirmed before cleaning.",
  specialty:
    "Specialty Cleaning\n\n" +
    "Soft Toy - from Rs 200\n" +
    "Helmet - from Rs 150\n" +
    "Carpet Dry Cleaning - from Rs 40/sq.ft\n" +
    "Bag Cleaning - from Rs 200\n\n" +
    "Final price confirmed before cleaning.",
};

const HELP_MSG =
  "Washkart - Here is what I can help with:\n\n" +
  "Book a pickup - type pickup\n" +
  "Check prices - type rates\n" +
  "Track your order - type track\n" +
  "Cancel an order - type cancel\n" +
  "Express service - type express after pickup\n" +
  "Repeat last booking - type same as last time\n\n" +
  "Hindi, Marathi, English - all work.\n" +
  "Closed on Thursdays.\n\n" +
  "www.washkart.co.in | Instagram: @_washkart_";

// ESTIMATE ENGINE
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
  sneaker:{shoes:350},shoe:{shoes:350},canvas:{shoes:300},
  bedsheet:{laundry:150,iron:60},blanket:{laundry:350},curtain:{dryclean:15},
  bag:{specialty:200},helmet:{specialty:150},carpet:{specialty:40},toy:{specialty:200},
};

function detectServiceNear(fullText, matchIndex, matchLength) {
  const w = fullText.toLowerCase().substring(Math.max(0, matchIndex - 30), matchIndex + matchLength + 30);
  if (/dry\s*clean|dryclean|dry-clean|\bdc\b/.test(w)) return "dryclean";
  if (/\biron\b|press|istri|steam/.test(w)) return "iron";
  if (/\bwash\b|\blaundry\b|dhulai|fold/.test(w)) return "laundry";
  if (/\bshoe|\bsneaker|\bjoote/.test(w)) return "shoes";
  return null;
}

function extractEstimateItems(rawText) {
  rawText = rawText.replace(/\bani\b/gi, "and").replace(/\baur\b/gi, "and");
  const itemRegex = /(\d+)\s*(sarees?|shirts?|pants?|trousers?|jeans?|kurtas?|kurtis?|suits?|dresses?|jackets?|sweaters?|lehengas?|lehnga|blazers?|dupattas?|bedsheets?|blankets?|sneakers?|shoes?|tshirts?|t-shirts?|gowns?|anarkali|sherwanis?|towels?|bags?|helmets?|carpets?)/gi;
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
      .replace(/sneakers?$/, "sneaker").replace(/shoes?$/, "shoe")
      .replace(/t-shirts?$|tshirts?$/, "tshirt").replace(/gowns?$/, "gown")
      .replace(/sherwanis?$/, "sherwani").replace(/towels?$/, "towel")
      .replace(/bags?$/, "bag").replace(/helmets?$/, "helmet").replace(/carpets?$/, "carpet");
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
      const lbl = svc === "dryclean" ? "Dry Clean" : svc === "iron" ? "Steam Iron" : svc === "laundry" ? "Laundry" : svc === "shoes" ? "Shoe Cleaning" : "Specialty";
      breakdown.push(`${qty}x ${item.name} (${lbl}) - Rs ${unitPrice * qty}`);
    } else { unknown.push(`${item.qty}x ${item.name}`); }
  }
  return { total, breakdown, unknown };
}

// SMART ITEM PRICE LOOKUP
const ITEM_PRICE_QUICK = [
  { items:["saree","sari"], svc:["wash","laundry","dhulai"], reply:"Saree Laundry - Rs 150/kg. Express available." },
  { items:["bedsheet","bed sheet","chadar"], svc:["wash","laundry"], reply:"Bedsheet Wash\nSingle - Rs 150 | Double - Rs 200" },
  { items:["blanket","razai","comforter"], svc:["wash","laundry"], reply:"Blanket / Comforter Wash\nSingle - Rs 350 | Double - Rs 450" },
  { items:["shirt","t-shirt","tshirt","top"], svc:["wash","laundry"], reply:"Shirt/T-Shirt\nWash and Fold Rs 80/kg | Wash and Iron Rs 110/kg" },
  { items:["saree","sari"], svc:["dry","dryclean","dc"], reply:"Saree Dry Clean\nRegular - Rs 350 | Silk - Rs 400 | With work - Rs 450" },
  { items:["lehenga","lehnga"], svc:["dry","dryclean","dc"], reply:"Lehenga Dry Clean - from Rs 350" },
  { items:["suit"], svc:["dry","dryclean","dc"], reply:"Suit Dry Clean\n2 Piece - Rs 400 | 3 Piece - from Rs 350" },
  { items:["blazer","coat"], svc:["dry","dryclean","dc"], reply:"Blazer / Coat Dry Clean - Rs 300" },
  { items:["jacket"], svc:["dry","dryclean","dc"], reply:"Jacket Dry Clean - Rs 250" },
  { items:["kurta","kurti"], svc:["dry","dryclean","dc"], reply:"Kurta / Kurti Dry Clean - Rs 100" },
  { items:["shirt","pant","trouser","jeans","tshirt","top"], svc:["dry","dryclean","dc"], reply:"Shirt / Pant / Jeans / Top Dry Clean - Rs 100/piece" },
  { items:["blouse"], svc:["dry","dryclean","dc"], reply:"Blouse Dry Clean - Rs 100 | With work - Rs 120" },
  { items:["sweater","sweatshirt"], svc:["dry","dryclean","dc"], reply:"Sweater / Sweatshirt Dry Clean - from Rs 200" },
  { items:["dupatta"], svc:["dry","dryclean","dc"], reply:"Dupatta Dry Clean - from Rs 120" },
  { items:["curtain","parda"], svc:["dry","dryclean","dc","clean"], reply:"Curtain Dry Clean - Rs 15/sq.ft" },
  { items:["bag","purse","handbag"], svc:["dry","dryclean","dc","clean"], reply:"Bag / Purse Cleaning - from Rs 200" },
  { items:["saree","sari"], svc:["iron","press","istri","steam"], reply:"Saree Steam Iron - Rs 120/piece" },
  { items:["lehenga","lehnga"], svc:["iron","press","istri","steam"], reply:"Lehenga Steam Iron - Rs 120/piece" },
  { items:["blazer","coat"], svc:["iron","press","istri","steam"], reply:"Blazer Steam Iron - Rs 120/piece" },
  { items:["kurta","kurti"], svc:["iron","press","istri","steam"], reply:"Kurta Steam Iron - Rs 30/piece" },
  { items:["shirt","pant","trouser","jeans"], svc:["iron","press","istri","steam"], reply:"Shirt / Pant Steam Iron - Rs 20/piece" },
  { items:["bedsheet","bed sheet"], svc:["iron","press","istri","steam"], reply:"Bedsheet Steam Iron - Rs 60/piece" },
  { items:["sneaker","canvas","white shoe"], svc:["clean","wash","shoe"], reply:"Canvas / Sneaker Cleaning - Rs 300/pair" },
  { items:["leather shoe","formal shoe","suede"], svc:["clean","wash","shoe"], reply:"Leather / Suede Shoe Cleaning - from Rs 400/pair" },
  { items:["sports shoe","running shoe"], svc:["clean","wash","shoe"], reply:"Sports Shoe Cleaning - Rs 350/pair" },
  { items:["helmet"], svc:["clean","wash"], reply:"Helmet Cleaning - from Rs 150" },
  { items:["soft toy","teddy","stuffed toy"], svc:["clean","wash"], reply:"Soft Toy Cleaning - from Rs 200" },
  { items:["carpet","rug"], svc:["clean","wash","dry"], reply:"Carpet Dry Cleaning - from Rs 40/sq.ft" },
];

const SERVICE_AVAIL = [
  { kw:["curtain","parda"], reply:"Yes, we clean curtains.\nDry Clean - Rs 15/sq.ft\nPickup and delivery included.\n\nType pickup to book." },
  { kw:["carpet","rug"], reply:"Yes, we do carpet dry cleaning.\nFrom Rs 40/sq.ft\n\nType pickup to book." },
  { kw:["helmet"], reply:"Yes, we clean helmets.\nFrom Rs 150/helmet\n\nType pickup to book." },
  { kw:["soft toy","teddy","stuffed toy"], reply:"Yes, we clean soft toys.\nFrom Rs 200\n\nType pickup to book." },
  { kw:["sofa","sofa cover","upholstery"], reply:"We clean sofa covers.\nPricing depends on size. Our team will assess at pickup.\n\nType pickup to book." },
  { kw:["bag","purse","handbag"], reply:"Yes, we clean bags and purses.\nFrom Rs 200\n\nType pickup to book." },
  { kw:["shoe","joote","sneaker","footwear"], reply:"Yes, we clean shoes.\nCanvas Rs 300 | Sneakers/Sports Rs 350 | Leather from Rs 400\n\nType pickup to book." },
  { kw:["lehenga","lehnga"], reply:"Yes, we dry clean lehengas.\nFrom Rs 350\n\nType pickup to book." },
  { kw:["saree","sari"], reply:"Yes, we dry clean sarees.\nRegular Rs 350 | Silk Rs 400 | With work Rs 450\n\nType pickup to book." },
  { kw:["blanket","razai","comforter","quilt"], reply:"Yes, we wash blankets and comforters.\nSingle Rs 350 | Double Rs 450\n\nType pickup to book." },
  { kw:["bedsheet","bed sheet","chadar"], reply:"Yes, we wash bedsheets.\nSingle Rs 150 | Double Rs 200\n\nType pickup to book." },
];

// DB HELPERS
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
async function logLead(phone, stage, firstMessage, branch, phoneNumberId) {
  try {
    const existing = await dbSelect("leads", `phone=eq.${phone}`).catch(() => []);
    const isNew = !existing.length;
    if (existing.length) {
      await dbUpdate("leads", `phone=eq.${phone}`, { stage, last_message: firstMessage, updated_at: new Date().toISOString(), branch: branch || "bavdhan" });
    } else {
      await dbInsert("leads", { phone, stage, first_message: firstMessage, last_message: firstMessage, branch: branch || "bavdhan", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    // Notify owner when brand new customer messages
    if (isNew && stage === "enquired") {
      const br = getBranchBySlug(branch) || DEFAULT_BRANCH;
      const numId = phoneNumberId || getBranchNumId(branch || "bavdhan");
      await sendMessage(OWNER_NUMBER, `New enquiry - ${br.name}\n\nPhone: +${phone}\nMessage: "${firstMessage}"\n\nFollow up from dashboard if needed.`, numId);
    }
  } catch (e) { console.log("[lead] skipped:", e.message); }
}

// NOTIFICATIONS
function safeNumId(numId) {
  // Never use BANER_NUMBER_ID placeholder — fall back to Bavdhan
  return (!numId || numId === "BANER_NUMBER_ID") ? "1136879376186203" : numId;
}

async function notifyAdmin(booking, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  const src = booking.source ? ` [${booking.source}]` : "";
  const msg = `New Booking${src} - ${br.name}\n\nOrder: ${booking.orderId}\nName: ${booking.name}\nPhone: +${booking.phone}\nAddress: ${booking.address || "Walk-in"}\nDate: ${booking.date || "-"}\nSlot: ${booking.slot || "-"}`;
  const nid = safeNumId(phoneNumberId);
  await sendMessage(br.admin, msg, nid);
  if (br.admin !== OWNER_NUMBER) await sendMessage(OWNER_NUMBER, msg, nid);
}
async function notifyAdminComplaint(phone, name, message, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin, `Complaint - ${br.name}\n\nName: ${name || "Unknown"}\nPhone: +${phone}\nMessage: "${message}"\n\nPlease follow up.`, phoneNumberId);
}
async function notifyAdminRating(phone, name, orderId, rating, comment, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin, `New Rating - ${br.name}\n\nName: ${name || phone}\nOrder: ${orderId || "unknown"}\nRating: ${rating}/5\nComment: ${comment || "None"}`, phoneNumberId);
}
async function notifyAdminPayment(phone, name, orderId, amount, method, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin,
    `Payment Received - ${br.name}\n\nName: ${name || phone}\nOrder: ${orderId || "unknown"}\nAmount: Rs ${amount}\nMethod: ${method}\n\nTo confirm: CONFIRM ${orderId}\nTo reject: REJECT ${orderId}`,
    phoneNumberId
  );
}
async function notifyAdminDroppedLead(phone, name, stage, branch, phoneNumberId) {
  const br = branch || DEFAULT_BRANCH;
  await sendMessage(br.admin,
    `Possible lead dropped - ${br.name}\n\nName: ${name || "Unknown"}\nPhone: +${phone}\nDropped at: ${stage}\n\nFollow up from dashboard.`,
    phoneNumberId
  );
}

// BOOKING HELPERS
async function askDate(phone, phoneNumberId) {
  const buttons = [];
  if (!isTodayThursday()) buttons.push({ id: "date_today", title: "Today" });
  if (!isTomorrowThursday()) buttons.push({ id: "date_tomorrow", title: "Tomorrow" });
  buttons.push({ id: "date_custom", title: "Another date" });
  await sendButtons(phone, "Which day should we pick up?\n(Closed Thursdays)", buttons, phoneNumberId);
}

async function askSlot(phone, phoneNumberId, forDate) {
  const now = new Date();
  const hour = now.getHours();
  const min  = now.getMinutes();
  const morningOpen = hour < 9 || (hour === 9 && min < 30);

  // If slot is being asked for a future date (not today), show both slots
  const isToday = !forDate || forDate === getToday();

  if (isToday && hour >= 16) {
    // Today is too late — but DON'T show date picker again, just show tomorrow slots
    await sendButtons(phone,
      "Evening slot is closed for today. Morning or Evening tomorrow?",
      [{ id: "slot_morning_tomorrow", title: "Morning tomorrow" }, { id: "slot_evening_tomorrow", title: "Evening tomorrow" }],
      phoneNumberId
    );
    return;
  }

  const buttons = [];
  if (!isToday || morningOpen) buttons.push({ id: "slot_morning", title: "Morning 10 AM - 1 PM" });
  buttons.push({ id: "slot_evening", title: "Evening 5 PM - 8 PM" });
  const note = (isToday && !morningOpen) ? "Morning slot is closed. Evening slot available:" : "Choose a time slot:";
  await sendButtons(phone, note, buttons, phoneNumberId);
}

async function askPriceCategory(phone, phoneNumberId) {
  await sendButtons(phone, "Which service?",
    [{ id: "price_iron", title: "Steam Iron" }, { id: "price_dc", title: "Dry Clean" }, { id: "price_wash", title: "Laundry" }],
    phoneNumberId
  );
  await delay(400);
  await sendButtons(phone, "More options:",
    [{ id: "price_shoe", title: "Shoes" }, { id: "price_specialty", title: "Specialty" }, { id: "btn_book", title: "Book Pickup" }],
    phoneNumberId
  );
}

async function askBranch(phone, phoneNumberId) {
  await sendButtons(phone, "Which branch is closer to you?",
    [{ id: "branch_bavdhan", title: "Bavdhan" }, { id: "branch_baner", title: "Baner" }],
    phoneNumberId
  );
}

async function showBookingConfirm(phone, session, phoneNumberId) {
  const bk = session.booking;
  await sendButtons(phone,
    `Confirm booking?\n\nDate: ${bk.date}\nSlot: ${bk.slot}\nAddress: ${bk.address}`,
    [{ id: "confirm_direct", title: "Confirm" }, { id: "date_custom", title: "Change date" }, { id: "update_details", title: "Change address" }],
    phoneNumberId
  );
  session.step = "direct_confirm";
}

async function confirmBooking(phone, booking, branch, phoneNumberId) {
  // Reschedule existing order instead of creating new
  if (booking.reschedule && booking.orderId) {
    const existingId = booking.orderId;
    await dbUpdate("bookings", `order_id=eq.${existingId}`, { date: booking.date, slot: booking.slot, reminder_sent: false });
    await sendMessage(phone,
      `✅ Rescheduled!\n\n🆔 ${existingId}\n📅 ${booking.date || "-"} | ${booking.slot || "-"}\n\nWe'll see you then! 🧺`,
      phoneNumberId
    );
    const br = branch || DEFAULT_BRANCH;
    await sendMessage(br.admin, `Rescheduled - ${br.name}\nOrder: ${existingId}\nNew date: ${booking.date}\nSlot: ${booking.slot}`, phoneNumberId);
    return;
  }
  const orderId = genOrderId();
  booking.orderId = orderId;
  booking.phone = phone;
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
  await logLead(phone, "converted", "booking confirmed", br.slug);
  // Clear address confirmation flag for next booking
  session.addressConfirmed = false;
  await sendMessage(phone,
    `✅ Booking confirmed!\n\n🆔 ${orderId}\n📍 ${booking.address || "-"}\n📅 ${booking.date || "-"} | ${booking.slot || "-"}\n\nOur team will arrive within your slot. 💚\nPayment via UPI QR or cash at delivery.\n\nTo cancel anytime, type *cancel*`,
    phoneNumberId
  );
  await delay(500);
  await sendMessage(phone,
    `Your clothes are in good hands! 🧺\n\nWe'll have them fresh and ready within 3 days.\nNeed them sooner? Reply *express* after pickup for our 120-minute turnaround.`,
    phoneNumberId
  );
  await notifyAdmin(booking, br, safeNumId(phoneNumberId));
}

// Drop-off timer
const dropoffTimers = {};
function setDropoffTimer(phone, name, stage, branch, phoneNumberId) {
  if (dropoffTimers[phone]) clearTimeout(dropoffTimers[phone]);
  dropoffTimers[phone] = setTimeout(async () => {
    const sess = sessionCache[phone];
    if (sess && sess.step !== "idle") {
      await notifyAdminDroppedLead(phone, name, stage, branch, phoneNumberId);
      await logLead(phone, "dropped", `dropped at ${stage}`, branch?.slug);
    }
  }, 30 * 60 * 1000);
}
function clearDropoffTimer(phone) {
  if (dropoffTimers[phone]) { clearTimeout(dropoffTimers[phone]); delete dropoffTimers[phone]; }
}

// Nudge timer
const nudgeTimers = {};
function setNudgeTimer(phone, phoneNumberId) {
  if (nudgeTimers[phone]) clearTimeout(nudgeTimers[phone]);
  nudgeTimers[phone] = setTimeout(async () => {
    const sess = sessionCache[phone];
    if (sess?.step === "direct_confirm") {
      await sendButtons(phone, "Still want to book? Tap Confirm or type pickup to start over.",
        [{ id: "confirm_direct", title: "Confirm" }, { id: "btn_book", title: "Start over" }],
        phoneNumberId
      );
    }
  }, 20 * 60 * 1000);
}
function clearNudgeTimer(phone) {
  if (nudgeTimers[phone]) { clearTimeout(nudgeTimers[phone]); delete nudgeTimers[phone]; }
}

// GEMINI AI
async function geminiChat(phone, userMessage, session, customer, activeOrder, lastOrder, branch) {
  const br = branch || DEFAULT_BRANCH;
  const history = (session.history || []).slice(-6);
  const systemPrompt = `You are a WhatsApp assistant for Washkart laundry in Pune, India.

RULES:
1. Default language is English. Switch to Hindi/Marathi only if customer writes in that language first.
2. Keep replies SHORT - 2 lines max. No long paragraphs.
3. No emojis.
4. Closed on Thursdays.
5. Never invent prices.

BRANCH: Washkart ${br.name}
CUSTOMER: ${customer?.name || "New"} | Address: ${customer?.address || "Not saved"}
ACTIVE ORDER: ${activeOrder ? `${activeOrder.order_id} - ${STATUS_MAP[activeOrder.status]?.label}` : "None"}
TODAY: ${getToday()}${isTodayThursday() ? " (THURSDAY - CLOSED)" : ""}
BOOKING: name=${session.booking?.name || "?"} address=${session.booking?.address || "?"} date=${session.booking?.date || "?"} slot=${session.booking?.slot || "?"}

RATES: Iron Rs20-120/pc | Dry Clean Rs100-450 | Laundry Rs80-110/kg | Shoes Rs300-400 | Express 120min 1.5x | Standard 3 days

RESPOND JSON only:
{"reply":"short reply","action":"none|book_now|need_name|need_address|need_date|need_slot|show_iron|show_dryclean|show_laundry|show_shoes|show_rates_menu|track_order|complaint|estimate","extracted":{"name":null,"address":null,"date":null,"slot":null,"items":null}}

HISTORY:
${history.map(h => `${h.role}: ${h.text}`).join("\n")}`;

  try {
    const res = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nCustomer: "${userMessage}"` }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
    });
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let clean = raw.replace(/\`\`\`json|\`\`\`/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) clean = m[0];
    const parsed = JSON.parse(clean);
    if (!parsed.extracted) parsed.extracted = {};
    return parsed;
  } catch (e) {
    console.error("Gemini error:", e?.response?.data || e.message);
    // Track Gemini failures and alert owner if too many
    if (!geminiChat.failCount) geminiChat.failCount = 0;
    geminiChat.failCount++;
    if (!geminiChat.failTimer) {
      geminiChat.failTimer = setTimeout(() => { geminiChat.failCount = 0; geminiChat.failTimer = null; }, 5 * 60 * 1000);
    }
    if (geminiChat.failCount >= 3) {
      geminiChat.failCount = 0;
      sendMessage(OWNER_NUMBER, "Bot alert: AI is failing repeatedly. Check Render logs.", "1136879376186203").catch(()=>{});
    }
    return { reply: "Sorry, I did not catch that. Type pickup, rates, or track.", action: "none", extracted: {} };
  }
}

// BUTTON GUARD
const TEXT_INPUT_STEPS = ["get_name","get_address","get_custom_date","feedback_comment","payment_method"];
function isButtonId(text) {
  return /^(price_|btn_|date_|slot_|branch_|use_saved|update_details|no_cancel|confirm_direct|rating_|pay_|cc_)/.test(text);
}

// MAIN HANDLER
async function handleMessage(phone, rawText, phoneNumberId) {
  phone = normalizePhone(phone);
  if (blockedNumbers.has(phone)) return;
  if (isRateLimited(phone)) { console.log(`[rate-limit] ${phone}`); return; }

  // If the message is from an admin number, only process admin commands
  // This prevents buttons in admin notifications from triggering booking flow
  // Only branch admins get the button-tap guard (not the owner)
  // Owner number can still use the bot as a normal customer
  const isBranchAdmin = Object.values(BRANCHES).some(br => normalizePhone(br.admin) === phone);
  const branch = getBranch(phoneNumberId);

  if (isBranchAdmin) {
    // Only process text admin commands — not button taps from notifications
    const isAdminCommand = /^(CONFIRM|REJECT|BLOCK|UNBLOCK|TAKEOVER|RESUME)\s/i.test(rawText);
    if (!isAdminCommand && isButtonId(rawText)) {
      return; // Admin tapped a button in a notification — silently ignore
    }
  }

  const session = await getSession(phone);
  if (session.takeoverActive) return; // bot paused for this customer
  const t = norm(rawText);
  if (!session.history) session.history = [];
  session.history.push({ role: "customer", text: rawText });
  if (session.history.length > 12) session.history = session.history.slice(-12);
  saveSession(phone, session);

  const send    = async (msg) => { await sendMessage(phone, msg, phoneNumberId); };
  const sendBtn = async (msg, btns) => { await sendButtons(phone, msg, btns, phoneNumberId); };

  // Button guard during text input steps
  if (TEXT_INPUT_STEPS.includes(session.step) && isButtonId(rawText)) {
    const msgs = { get_name:"Please type your name first.", get_address:"Please type your pickup address first.", get_custom_date:"Please type the date first (e.g. 25 August)." };
    await send(msgs[session.step] || "Please complete the current step first.");
    return;
  }

  // Reset
  if (has(t, ...RESET_KW)) {
    session.step = "idle"; session.booking = {};
    clearDropoffTimer(phone); clearNudgeTimer(phone);
    saveSession(phone, session);
    await sendBtn("Starting fresh. How can I help?",
      [{ id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
    );
    return;
  }

  // LAYER 1: Session steps
  if (session.step === "get_name") {
    if (rawText.trim().length < 2) { await send("Please type your name."); return; }
    session.booking.name = rawText.trim();
    session.step = "idle";
    if (!session.booking.address) { session.step="get_address"; await send(`Thanks ${session.booking.name}. What is your pickup address?`); }
    else if (!session.booking.branch) { session.step="select_branch"; await askBranch(phone,phoneNumberId); }
    else if (!session.booking.date) { await askDate(phone,phoneNumberId); session.step="select_date"; }
    else if (!session.booking.slot) { await askSlot(phone,phoneNumberId); session.step="select_slot"; }
    else { await showBookingConfirm(phone,session,phoneNumberId); }
    saveSession(phone,session); return;
  }

  if (session.step === "get_address") {
    if (rawText.trim().length < 3) { await send("Please type your full address."); return; }
    session.booking.address = rawText.trim();
    if (session.booking.name) await saveCustomer(phone, session.booking.name, session.booking.address, session.booking.branch || branch.slug);
    const detected = detectBranchFromAddress(session.booking.address);
    if (detected) session.booking.branch = detected;
    session.step = "idle";
    if (!session.booking.branch) { session.step="select_branch"; await askBranch(phone,phoneNumberId); }
    else if (!session.booking.date) { await askDate(phone,phoneNumberId); session.step="select_date"; }
    else if (!session.booking.slot) { await askSlot(phone,phoneNumberId); session.step="select_slot"; }
    else { await showBookingConfirm(phone,session,phoneNumberId); }
    saveSession(phone,session); return;
  }

  if (session.step === "get_custom_date") {
    if (isThursdayStr(rawText)) { await send("We are closed on Thursdays. Please choose another day."); await delay(300); await askDate(phone,phoneNumberId); return; }
    const dayNum = parseInt(rawText.trim());
    if (!isNaN(dayNum) && rawText.trim().length <= 2 && dayNum < new Date().getDate()) { await send("That date has passed. Please enter an upcoming date."); return; }
    session.booking.date = rawText.trim(); session.step = "idle";
    if (!session.booking.slot) {
      await askSlot(phone, phoneNumberId, session.booking.date);
      session.step="select_slot";
    }
    else { await showBookingConfirm(phone,session,phoneNumberId); }
    saveSession(phone,session); return;
  }

  if (session.step === "tracking") {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings", `order_id=eq.${m[0].toUpperCase()}`).catch(()=>[]);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label:rows[0].status, eta:"" };
        const del = rows[0].delivery_date ? `\nEstimated delivery: ${rows[0].delivery_date}` : "";
        await send(`Order: ${rows[0].order_id}\nStatus: ${s.label}${del}\n\n${s.eta}`);
      } else { await send("Order not found. Please check the ID."); }
      session.step = "idle"; saveSession(phone,session); return;
    }
    session.step = "idle"; saveSession(phone,session);
    await sendBtn("Please share a valid order ID like FW-1234.",
      [{id:"btn_book",title:"Book Pickup"},{id:"btn_track",title:"Try Again"}]
    );
    return;
  }

  if (session.step === "confirm_cancel") {
    if (rawText.startsWith("cc_")) {
      const orderId = rawText.replace("cc_","");
      const rows = await dbSelect("bookings",`order_id=eq.${orderId}`).catch(()=>[]);
      await dbUpdate("bookings",`order_id=eq.${orderId}`,{status:"cancelled"});
      await send(`Order ${orderId} has been cancelled.\n\nTo book again, type pickup.`);
      if (rows[0]) await sendMessage(branch.admin, `Cancelled - ${branch.name}\nOrder: ${orderId}\nName: ${rows[0].name}\nDate: ${rows[0].date}`, phoneNumberId);
    } else if (rawText === "no_cancel") {
      await send("Your order is still active.");
    } else { await send("Tap Yes, Cancel to confirm."); return; }
    session.step = "idle"; saveSession(phone,session); return;
  }

  if (session.step === "direct_confirm") {
    clearNudgeTimer(phone);
    const bk = session.booking;
    if (rawText === "confirm_direct" || has(t,...YES_KW)) {
      session.step = "idle";
      if (bk.name && bk.address && bk.date && bk.slot) {
        await confirmBooking(phone, bk, getBranchBySlug(bk.branch)||branch, phoneNumberId);
        session.booking = {};
      } else { await send("Some details are missing. Type pickup to start again."); }
      saveSession(phone,session); return;
    }
    if (rawText === "date_custom") { session.step="get_custom_date"; saveSession(phone,session); await send("Enter a date (e.g. 25 August):"); return; }
    if (rawText === "update_details") { session.booking.address=null; session.step="get_address"; saveSession(phone,session); await send("Enter your new pickup address:"); return; }
    if (has(t,...NO_KW)) { session.step="idle"; session.booking={}; saveSession(phone,session); await send("No problem. Type pickup whenever you are ready."); return; }
    await showBookingConfirm(phone,session,phoneNumberId); return;
  }

  if (session.step === "confirm_address") {
    if (rawText === "use_saved" || has(t,...YES_KW)) {
      session.addressConfirmed = true;
      session.step = "idle";
      saveSession(phone, session);
      // Go directly to date selection instead of re-entering handleBookingIntent
      if (!session.booking.date) { await askDate(phone,phoneNumberId); session.step="select_date"; saveSession(phone,session); }
      else if (!session.booking.slot) { await askSlot(phone,phoneNumberId); session.step="select_slot"; saveSession(phone,session); }
      else { await showBookingConfirm(phone,session,phoneNumberId); }
      return;
    }
    if (rawText === "update_details") {
      session.booking.address = null;
      session.addressConfirmed = true;
      session.step = "get_address";
      saveSession(phone, session);
      await sendMessage(phone, "What is your new pickup address?", phoneNumberId);
      return;
    }
    // Any other response - treat as address
    session.booking.address = rawText.trim();
    session.addressConfirmed = true;
    session.step = "idle";
    saveSession(phone, session);
    await handleBookingIntent(phone, session, rawText, t, branch, phoneNumberId);
    return;
  }

  if (session.step === "select_branch") {
    if (rawText !== "branch_bavdhan" && rawText !== "branch_baner") {
      await askBranch(phone,phoneNumberId); return;
    }
    // Branch buttons are handled above in Layer 2 — this step is now redundant
    // Fall through to Layer 2 button handler
  }

  if (session.step === "feedback") {
    const ratingMap = {"rating_excellent":5,"rating_good":4,"rating_poor":2};
    const lastOrder = await getLastOrder(phone);
    const customer  = await getCustomer(phone);
    if (ratingMap[rawText] !== undefined) {
      const stars = ratingMap[rawText];
      await saveRating(phone, lastOrder?.order_id, stars, null, branch.slug);
      await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, stars, null, branch, phoneNumberId);
      if (stars === 5) {
        await send("Thank you for the rating. We appreciate your support.");
        session.step = "idle"; saveSession(phone,session);
        await delay(500);
        await sendBtn("Need anything else?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Check Rates"}]);
      } else if (stars === 4) {
        await send("Thanks. Is there anything we can improve?");
        session.step = "feedback_comment"; saveSession(phone,session);
      } else {
        await send("We are sorry. Please describe what went wrong and we will fix it.");
        await notifyAdminComplaint(phone, customer?.name, `Low rating (${stars}/5)`, branch, phoneNumberId);
        session.step = "feedback_comment"; saveSession(phone,session);
      }
      return;
    }
    await saveRating(phone, lastOrder?.order_id, null, rawText, branch.slug);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "comment", rawText, branch, phoneNumberId);
    await send("Thank you for the feedback.");
    session.step = "idle"; saveSession(phone,session); return;
  }

  if (session.step === "feedback_comment") {
    const lastOrder = await getLastOrder(phone);
    const customer  = await getCustomer(phone);
    await saveRating(phone, lastOrder?.order_id, null, rawText, branch.slug);
    await notifyAdminRating(phone, customer?.name, lastOrder?.order_id, "comment", rawText, branch, phoneNumberId);
    await send("Thank you. We will work on this.");
    session.step = "idle"; saveSession(phone,session); return;
  }

  if (session.step === "payment_method") {
    const active   = await getActiveOrder(phone);
    const customer = await getCustomer(phone);
    const orderId  = session.paymentOrderId || active?.order_id;
    let method = "UPI";
    if (rawText === "pay_cash" || has(t,"cash","nakad")) method = "Cash";
    else if (rawText === "pay_upi" || has(t,"upi","gpay","phonepe","paytm","online")) method = "UPI";
    await send(`${method} payment noted. Admin will confirm shortly.`);
    await notifyAdminPayment(phone, customer?.name, orderId, session.paymentAmount||0, method, branch, phoneNumberId);
    session.step = "idle"; delete session.paymentOrderId; delete session.paymentAmount;
    saveSession(phone,session); return;
  }

  // Admin commands
  if (isBranchAdmin) {
    const confirmMatch  = rawText.match(/^CONFIRM\s+(FW-\d+)/i);
    const rejectMatch   = rawText.match(/^REJECT\s+(FW-\d+)/i);
    const blockMatch    = rawText.match(/^BLOCK\s+(\d+)/i);
    const unblockMatch  = rawText.match(/^UNBLOCK\s+(\d+)/i);
    const takeoverMatch = rawText.match(/^TAKEOVER\s+(\d+)/i);
    const resumeMatch   = rawText.match(/^RESUME\s+(\d+)/i);
    if (confirmMatch) {
      const orderId = confirmMatch[1].toUpperCase();
      const rows = await dbSelect("bookings",`order_id=eq.${orderId}`).catch(()=>[]);
      await dbUpdate("bookings",`order_id=eq.${orderId}`,{payment_status:"paid",payment_date:new Date().toISOString()});
      await send(`Payment confirmed for ${orderId}.`);
      if (rows[0]?.phone) await sendMessage(rows[0].phone,`Payment confirmed for order ${orderId}. Thank you.`,phoneNumberId);
      return;
    }
    if (rejectMatch) {
      const orderId = rejectMatch[1].toUpperCase();
      const rows = await dbSelect("bookings",`order_id=eq.${orderId}`).catch(()=>[]);
      await send(`Payment rejected for ${orderId}.`);
      if (rows[0]?.phone) await sendMessage(rows[0].phone,`Hi, payment for order ${orderId} could not be confirmed. Please contact us.`,phoneNumberId);
      return;
    }
    if (blockMatch) { const num = normalizePhone(blockMatch[1]); blockedNumbers.add(num); await send(`${num} blocked.`); return; }
    if (unblockMatch) { const num = normalizePhone(unblockMatch[1]); blockedNumbers.delete(num); await send(`${num} unblocked.`); return; }
    if (takeoverMatch) {
      const num = normalizePhone(takeoverMatch[1]);
      if (!sessionCache[num]) sessionCache[num] = {step:"idle",booking:{},history:[]};
      sessionCache[num].takeoverActive = true;
      await send(`Takeover active for ${num}. Reply RESUME ${num} to hand back.`); return;
    }
    if (resumeMatch) {
      const num = normalizePhone(resumeMatch[1]);
      if (sessionCache[num]) sessionCache[num].takeoverActive = false;
      await send(`Bot resumed for ${num}.`); return;
    }
  }

  // LAYER 2: Button IDs
  const RATE_FOLLOWUP = async () => {
    await delay(400);
    await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"}]);
    trackRatesNoBooking(phone, branch, phoneNumberId); // track if no booking follows
  };
  if (rawText==="price_iron")      { await send(RATES.iron);      await RATE_FOLLOWUP(); return; }
  if (rawText==="price_dc")        { await send(RATES.dryclean);  await RATE_FOLLOWUP(); return; }
  if (rawText==="price_wash")      { await send(RATES.laundry);   await RATE_FOLLOWUP(); return; }
  if (rawText==="price_shoe")      { await send(RATES.shoes);     await RATE_FOLLOWUP(); return; }
  if (rawText==="price_specialty") { await send(RATES.specialty); await RATE_FOLLOWUP(); return; }
  if (rawText==="btn_price")       { await askPriceCategory(phone,phoneNumberId); return; }
  if (rawText==="btn_track")       { await handleTrack(phone,session,null,phoneNumberId); return; }
  if (rawText==="date_today")      { await handleDateButton(phone,session,"today",phoneNumberId); return; }
  if (rawText==="date_tomorrow")   { await handleDateButton(phone,session,"tomorrow",phoneNumberId); return; }
  if (rawText==="date_custom")     { session.step="get_custom_date"; saveSession(phone,session); await send("Enter a date (e.g. 25 August):\n(Closed Thursdays)"); return; }
  if (rawText==="slot_morning")    { session.booking.slot="Morning (10 AM - 1 PM)"; await handleSlotSelected(phone,session,phoneNumberId); return; }
  if (rawText==="slot_evening")    { session.booking.slot="Evening (5 PM - 8 PM)";  await handleSlotSelected(phone,session,phoneNumberId); return; }
  if (rawText==="slot_morning_tomorrow") {
    if (!session.booking.date || session.booking.date === getToday()) session.booking.date = getTomorrow();
    session.booking.slot = "Morning (10 AM - 1 PM)";
    await handleSlotSelected(phone, session, phoneNumberId); return;
  }
  if (rawText==="slot_evening_tomorrow") {
    if (!session.booking.date || session.booking.date === getToday()) session.booking.date = getTomorrow();
    session.booking.slot = "Evening (5 PM - 8 PM)";
    await handleSlotSelected(phone, session, phoneNumberId); return;
  }
  if (rawText==="branch_bavdhan" || rawText==="branch_baner") {
    session.booking.branch = rawText==="branch_bavdhan" ? "bavdhan" : "baner";
    const cust = await getCustomer(phone);
    if (cust) await saveCustomer(phone, cust.name, cust.address, session.booking.branch);
    session.step = "idle";
    if (!session.booking.date) { await askDate(phone,phoneNumberId); session.step="select_date"; }
    else if (!session.booking.slot) { await askSlot(phone,phoneNumberId); session.step="select_slot"; }
    else { await showBookingConfirm(phone,session,phoneNumberId); }
    saveSession(phone,session); return;
  }
  if (rawText==="use_saved")       { const s=await getCustomer(phone); if(s){session.booking.name=s.name;session.booking.address=s.address;if(s.branch)session.booking.branch=s.branch;} await askDate(phone,phoneNumberId); session.step="select_date"; saveSession(phone,session); return; }
  if (rawText==="update_details")  { session.booking.address=null; session.step="get_address"; saveSession(phone,session); await send("Enter your new pickup address:"); return; }
  if (rawText==="no_cancel")       { await send("Your order is still active."); return; }
  if (rawText==="confirm_direct")  {
    clearNudgeTimer(phone);
    const bk = session.booking;
    if (bk.name && bk.address && bk.date && bk.slot) {
      session.step = "idle";
      await confirmBooking(phone, bk, getBranchBySlug(bk.branch)||branch, phoneNumberId);
      session.booking = {}; saveSession(phone,session);
    } else { await send("Some details are missing. Type pickup to start again."); }
    return;
  }
  if (rawText==="express_yes") { await handleExpress(phone,branch,phoneNumberId); return; }
  if (rawText==="express_no")  { await send("Got it! We'll have your clothes ready in 3 days. \u{1F9BA}"); return; }
  if (rawText==="btn_book") {
    session.booking={};
    session.allowAnotherBooking = true; // bypass active order check for this tap
    saveSession(phone,session);
  }

  // LAYER 3: Keywords
  if (rawText==="__audio__")    { await send("I cannot listen to voice notes. Please type your message."); return; }
  if (rawText==="__image__")    { await send("I cannot view photos. Please describe what you need or type pickup."); return; }
  if (rawText==="__video__")    { await send("I cannot view videos. Please type your message."); return; }
  if (rawText==="__document__") { await send("I cannot open documents. Please type your message."); return; }
  if (rawText==="__sticker__")  { await sendBtn("Hi! How can I help?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]); return; }

  if (isTodayThursday() && !has(t,"track","status","order","cancel","paid","rating")) {
    await sendBtn("Today is Thursday - we are closed.\n\nWe open again tomorrow. Book for tomorrow?",
      [{id:"date_tomorrow",title:"Book for Tomorrow"},{id:"btn_track",title:"Track Order"}]
    );
    return;
  }
  if (has(t,...OPERATING_HOURS_KW)) { await send("We operate Monday to Wednesday and Friday to Sunday, 9 AM to 8 PM.\n\nClosed on Thursdays."); return; }
  if (has(t,...WRONG_NUMBER_KW))    { await send("This is Washkart's WhatsApp - laundry and dry cleaning in Pune.\n\nwww.washkart.co.in | @_washkart_\n\nType pickup or rates to get started."); return; }
  if (has(t,...LOCATION_KW))        { await send("Washkart Locations\n\nBavdhan: Near DSK Vishwa, Bavdhan, Pune\nBaner: Baner, Pune\n\nDoorstep pickup and delivery available.\nwww.washkart.co.in"); return; }
  if (has(t,...WEBSITE_KW))         { await send("Washkart Online\n\nWebsite: www.washkart.co.in\nInstagram: @_washkart_"); return; }
  if (has(t,...DELIVERY_TIME_KW)) {
    const active = await getActiveOrder(phone);
    if (active && active.delivery_date) { await send(`Order ${active.order_id}\nStatus: ${STATUS_MAP[active.status]?.label}\nEstimated delivery: ${active.delivery_date}`); }
    else { await send("Standard delivery: 3 days.\nExpress: 120 minutes (1.5x price).\n\nClosed Thursdays."); }
    return;
  }
  if (has(t,...BULK_KW)) {
    await send("We handle bulk orders. Special rates available.\n\nOur team will call you. Type pickup and mention it is a bulk order.");
    await sendMessage(branch.admin, `Bulk order inquiry\nPhone: +${phone}\nMessage: ${rawText}`, phoneNumberId);
    return;
  }
  if (has(t,...COMPLAINT_KW)) {
    await send("We are sorry to hear this. 🙏\n\nPlease describe what happened and we will resolve it right away.\n\nFor urgent issues, call us directly: +91 92725 42419");
    await notifyAdminComplaint(phone, null, rawText, branch, phoneNumberId);
    return;
  }
  if (has(t,...THANKS_KW)) {
    const customer = await getCustomer(phone);
    await send(`You are welcome${customer?.name ? ", " + customer.name : ""}. Feel free to reach out anytime.`);
    return;
  }
  if (["ok","okay","done","theek","theek hai","accha","acha","achha","sahi","noted","hmm","hm"].some(w => t.trim()===w)) {
    await sendBtn("Anything else?",
      [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
    );
    return;
  }
  if (has(t,...HELP_KW))                              { await send(HELP_MSG); return; }
  if (has(t,...RESCHEDULE_KW))                         { await handleReschedule(phone,session,branch,phoneNumberId); return; }
  if (has(t,...CANCEL_KW))                            { await handleCancel(phone,session,rawText,branch,phoneNumberId); return; }
  if (has(t,...TRACK_KW)||has(t,...ORDER_READY_KW))   { await handleTrack(phone,session,rawText,phoneNumberId); return; }
  if (has(t,...EXPRESS_KW)&&session.step==="idle")    { await handleExpress(phone,branch,phoneNumberId); return; }
  if (has(t,...SAME_KW))                              { await handleSameAsLast(phone,session,phoneNumberId); return; }
  if (has(t,...PAYMENT_KW))                           { await handlePayment(phone,session,branch,phoneNumberId); return; }
  if (has(t,...AVAIL_KW)) {
    for (const s of SERVICE_AVAIL) { if (s.kw.some(k=>t.includes(k))) { await send(s.reply); return; } }
  }
  // Single-word service queries that should go direct to rates
  const SINGLE_SERVICE = {
    "washing":["wash","laundry"],"laundry":["wash","laundry"],"ironing":["iron","press"],
    "drycleaning":["dry","dryclean"],"dryclean":["dry","dryclean"],"pressing":["iron","press"],
    "shoes":["shoe","sneaker"],"shoe":["shoe","sneaker"],"sneakers":["shoe","sneaker"],
  };
  if (SINGLE_SERVICE[t.trim()]) {
    const svcWords = SINGLE_SERVICE[t.trim()];
    if (svcWords.includes("wash"))  { await send(RATES.laundry);   await delay(400); await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]); return; }
    if (svcWords.includes("iron"))  { await send(RATES.iron);      await delay(400); await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]); return; }
    if (svcWords.includes("dry"))   { await send(RATES.dryclean);  await delay(400); await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]); return; }
    if (svcWords.includes("shoe"))  { await send(RATES.shoes);     await delay(400); await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]); return; }
  }

  if (has(t,...GREET_KW)) {
    const customer = await getCustomer(phone);
    const active   = await getActiveOrder(phone);
    await logLead(phone,"enquired",rawText,branch.slug,phoneNumberId);
    if (customer) {
      if (active) {
        await sendBtn(`Hi ${customer.name}. Your order ${active.order_id} is ${STATUS_MAP[active.status]?.label}.`,
          [{id:"btn_track",title:"Track Order"},{id:"btn_book",title:"New Booking"}]
        );
      } else {
        await sendBtn(`Hi ${customer.name}. How can I help?`,
          [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
        );
      }
    } else {
      // Check if they have a previous booking from website
      const prevBooking = await getLastOrder(phone).catch(() => null);
      if (prevBooking?.name) {
        await sendBtn(`Hi ${prevBooking.name}! 👋 Welcome to Washkart.\n\nHow can I help you today?`,
          [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
        );
      } else {
        await sendBtn("Hi! 👋 Welcome to Washkart — laundry and dry cleaning in Pune.",
          [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
        );
      }
    }
    return;
  }
  // Quantity-based estimate check — must happen BEFORE generic rates routing
  // KG laundry calculator
  const kgMatch = rawText.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (kgMatch && has(t,"wash","laundry","fold","iron","dhulai")) {
    const kg = parseFloat(kgMatch[1]);
    const wf  = Math.round(kg * 80);
    const wi  = Math.round(kg * 110);
    const exWf = Math.round(kg * 120);
    const exWi = Math.round(kg * 160);
    await send(`Laundry estimate for ${kg} kg:\n\nWash & Fold - Rs ${wf}\nWash & Iron - Rs ${wi}\n\nExpress (90 min):\nWash & Fold - Rs ${exWf}\nWash & Iron - Rs ${exWi}\n\nFinal amount confirmed at pickup.`);
    await delay(400);
    await sendBtn("Ready to book?", [{id:"btn_book",title:"Book Pickup"}]);
    return;
  }

  const hasQuantity = /\b\d+\s*(kg|sarees?|shirts?|pants?|jeans?|kurtas?|kurtis?|suits?|dresses?|jackets?|sweaters?|lehengas?|blazers?|dupattas?|bedsheets?|blankets?|sneakers?|shoes?|tshirts?|pieces?|pcs?|kapde|items?)\b/i.test(rawText);
  if (hasQuantity && (has(t,"dry","dryclean","wash","iron","press","laundry","clean","shoe","kg"))) {
    const items = extractEstimateItems(rawText);
    if (items.length > 0) {
      const {total, breakdown, unknown} = calcEstimate(items);
      if (total > 0) {
        let msg = "Here's your estimate: \n\n";
        breakdown.forEach(l => msg += l + "\n");
        if (unknown.length) msg += "\nCould not estimate: " + unknown.join(", ") + "\n";
        msg += "\nTotal: Rs " + total;
        msg += "\nExpress (120 min): Rs " + Math.ceil(total * 1.5);
        msg += "\n\nStandard turnaround is 3 days. Final amount confirmed before cleaning starts.";
        await send(msg);
        await delay(400);
        await sendBtn("Ready to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]);
        return;
      }
    }
  }

  if (has(t,...RATES_KW)) {
    for (const entry of ITEM_PRICE_QUICK) {
      if (entry.items.some(i=>t.includes(i)) && entry.svc.some(s=>t.includes(s))) {
        await send(entry.reply + "\n\nStandard: 3 days | Express: 120 min");
        await delay(400);
        await sendBtn("Ready to book a pickup?", [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"See All Rates"}]);
        return;
      }
    }
    if (has(t,"iron","press","istri"))                           { await send(RATES.iron);      await RATE_FOLLOWUP(); return; }
    if (has(t,"dry","dryclean","dry clean","dc"))                { await send(RATES.dryclean);  await RATE_FOLLOWUP(); return; }
    if (has(t,"wash","laundry","dhulai","fold"))                 { await send(RATES.laundry);   await RATE_FOLLOWUP(); return; }
    if (has(t,"shoe","sneaker","joote","footwear"))              { await send(RATES.shoes);     await RATE_FOLLOWUP(); return; }
    if (has(t,"specialty","carpet","helmet","toy","curtain","rug","sofa")) { await send(RATES.specialty); await RATE_FOLLOWUP(); return; }
    await askPriceCategory(phone,phoneNumberId); return;
  }
  if (has(t,...BOOKING_KW)||rawText==="btn_book") { await handleBookingIntent(phone,session,rawText,t,branch,phoneNumberId); return; }

  // LAYER 4: Gemini
  const customer  = await getCustomer(phone);
  const active    = await getActiveOrder(phone);
  const lastOrder = await getLastOrder(phone);
  if (customer) {
    if (!session.booking.name)    session.booking.name    = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
    if (!session.booking.branch && customer.branch) session.booking.branch = customer.branch;
  }
  await logLead(phone,"enquired",rawText,branch.slug);
  const ai = await geminiChat(phone,rawText,session,customer,active,lastOrder,branch);
  console.log(`[AI] action:${ai.action} reply:${ai.reply?.slice(0,50)}`);

  if (ai.extracted?.name    && !session.booking.name)    session.booking.name    = ai.extracted.name;
  if (ai.extracted?.address && !session.booking.address) session.booking.address = ai.extracted.address;
  if (ai.extracted?.date) {
    const d = ai.extracted.date;
    session.booking.date = d==="today"?getToday():d==="tomorrow"?getTomorrow():d==="day_after_tomorrow"?getDayAfter():d;
    if (isThursdayStr(session.booking.date)) { session.booking.date=null; await send("We are closed on Thursdays."); await askDate(phone,phoneNumberId); return; }
  }
  if (ai.extracted?.slot==="morning") session.booking.slot="Morning (10 AM - 1 PM)";
  if (ai.extracted?.slot==="evening") session.booking.slot="Evening (5 PM - 8 PM)";

  const RATE_FU = async () => { await delay(400); await sendBtn("Want to book a pickup?", [{id:"btn_book",title:"Book Pickup"}]); };
  switch (ai.action) {
    case "book_now":
      if (active && active.status!=="cancelled" && active.status!=="delivered" && !session.allowAnotherBooking) {
        await sendBtn(`You have an active order ${active.order_id} (${STATUS_MAP[active.status]?.label}). Book another pickup?`,
          [{id:"btn_book",title:"Yes, book another"},{id:"btn_track",title:"Track existing"}]
        ); return;
      }
      session.allowAnotherBooking = false;
      if (session.booking.name && session.booking.address && session.booking.date && session.booking.slot) {
        await confirmBooking(phone,session.booking,getBranchBySlug(session.booking.branch)||branch,phoneNumberId); session.booking={};
      } else { await handleBookingIntent(phone,session,rawText,t,branch,phoneNumberId); }
      break;
    case "need_name":    session.step="get_name";    await send(ai.reply||"What is your name?"); break;
    case "need_address": session.step="get_address"; await send(ai.reply||"What is your pickup address?"); break;
    case "need_date":    if(ai.reply)await send(ai.reply); await delay(300); await askDate(phone,phoneNumberId); session.step="select_date"; break;
    case "need_slot":    if(ai.reply)await send(ai.reply); await delay(300); await askSlot(phone,phoneNumberId); session.step="select_slot"; break;
    case "show_rates_menu": await askPriceCategory(phone,phoneNumberId); break;
    case "show_iron":    await send(RATES.iron);     await RATE_FU(); break;
    case "show_dryclean":await send(RATES.dryclean); await RATE_FU(); break;
    case "show_laundry": await send(RATES.laundry);  await RATE_FU(); break;
    case "show_shoes":   await send(RATES.shoes);    await RATE_FU(); break;
    case "track_order":
      if (active) {
        const s = STATUS_MAP[active.status]||{label:active.status,eta:""};
        const del = active.delivery_date?`\nEstimated delivery: ${active.delivery_date}`:"";
        await send(`Order ${active.order_id}\nStatus: ${s.label}${del}\n\n${s.eta}`);
      } else { await send(ai.reply||"No active order. Type pickup to book."); }
      break;
    case "complaint":
      await send(ai.reply||"We are sorry. Our team will follow up.");
      await notifyAdminComplaint(phone,customer?.name,rawText,branch,phoneNumberId); break;
    case "estimate": {
      const items = extractEstimateItems(rawText);
      if (items.length > 0) {
        const {total,breakdown,unknown} = calcEstimate(items);
        if (total > 0) {
          let msg = "Estimate\n\n";
          breakdown.forEach(l => msg += `${l}\n`);
          if (unknown.length) msg += `\nCould not estimate: ${unknown.join(", ")}\n`;
          msg += `\nTotal: Rs ${total}\nExpress (120 min): Rs ${Math.ceil(total*1.5)}\n\nFinal amount confirmed before cleaning.`;
          await send(msg); await RATE_FU();
        } else { await send(ai.reply||"Please mention item and service. e.g. 3 shirts dry clean"); }
      } else {
        const numMatch = rawText.match(/(\d+)\s*(kapde|clothes|shirts?|pants?|sarees?)/i);
        if (numMatch) {
          await sendBtn("Which service?",
            [{id:"price_dc",title:"Dry Clean"},{id:"price_iron",title:"Steam Iron"},{id:"price_wash",title:"Laundry"}]
          );
        } else { await send(ai.reply||"e.g. 3 shirts dry clean, 2 sarees iron"); }
      }
      break;
    }
    default:
      if (ai.reply) { await send(ai.reply); }
      else {
        await sendBtn(customer?`Hi ${customer.name}. How can I help?`:"Hi. Welcome to Washkart.",
          [{id:"btn_book",title:"Book Pickup"},{id:"btn_price",title:"Rates"},{id:"btn_track",title:"Track Order"}]
        );
      }
  }
  if (ai.reply) session.history.push({role:"bot",text:ai.reply});
  saveSession(phone,session);
}

// FLOW HELPERS
async function handleDateButton(phone, session, which, phoneNumberId) {
  const now = new Date();
  const hour = now.getHours();

  if (which==="today") {
    if (isTodayThursday()) {
      await sendMessage(phone,"Today is Thursday - we are closed.",phoneNumberId);
      await askDate(phone,phoneNumberId); return;
    }
    if (hour >= 20) {
      // After 8 PM — too late even for evening slot
      await sendMessage(phone,"We are closed for today. Let us schedule for tomorrow.",phoneNumberId);
      if (isTomorrowThursday()) { await sendMessage(phone,"Tomorrow is Thursday too. Let us find another day.",phoneNumberId); await askDate(phone,phoneNumberId); return; }
      session.booking.date = getTomorrow();
      session.step = "select_slot"; saveSession(phone,session);
      await askSlot(phone,phoneNumberId,session.booking.date); return;
    }
    session.booking.date = getToday();
  } else {
    if (isTomorrowThursday()) {
      await sendMessage(phone,"Tomorrow is Thursday - we are closed.",phoneNumberId);
      await askDate(phone,phoneNumberId); return;
    }
    session.booking.date = getTomorrow();
  }
  session.step = "select_slot"; saveSession(phone,session);
  await askSlot(phone,phoneNumberId,session.booking.date);
}

async function handleSlotSelected(phone, session, phoneNumberId) {
  session.step = "idle";
  const bk = session.booking;
  console.log(`[slot] name:${bk.name} addr:${bk.address} date:${bk.date} slot:${bk.slot} branch:${bk.branch}`);
  if (!bk.name || !bk.address) {
    const customer = await getCustomer(phone);
    if (customer) { if(!bk.name)bk.name=customer.name; if(!bk.address)bk.address=customer.address; if(!bk.branch&&customer.branch)bk.branch=customer.branch; }
  }
  if (!bk.branch) {
    const detected = detectBranchFromAddress(bk.address);
    if (detected) { bk.branch=detected; }
    else { session.step="select_branch"; saveSession(phone,session); await askBranch(phone,phoneNumberId); return; }
  }
  if (bk.name && bk.address && bk.date && bk.slot) {
    const customer = await getCustomer(phone);
    if (customer) {
      clearDropoffTimer(phone);
      await confirmBooking(phone, bk, getBranchBySlug(bk.branch)||getBranch(phoneNumberId), phoneNumberId);
      session.booking = {};
    } else { await showBookingConfirm(phone,session,phoneNumberId); setNudgeTimer(phone,phoneNumberId); }
  } else if (!bk.date) { await askDate(phone,phoneNumberId); session.step="select_date"; }
  else if (!bk.name) { await sendMessage(phone,"What is your name?",phoneNumberId); session.step="get_name"; }
  else if (!bk.address) { await sendMessage(phone,"What is your pickup address?",phoneNumberId); session.step="get_address"; }
  saveSession(phone,session);
}

async function handleTrack(phone, session, rawText, phoneNumberId) {
  // Check for explicit order ID first
  if (rawText) {
    const m = rawText.match(/FW-\d+/i);
    if (m) {
      const rows = await dbSelect("bookings",`order_id=eq.${m[0].toUpperCase()}`).catch(()=>[]);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status]||{label:rows[0].status,eta:""};
        const del = rows[0].delivery_date?`\nEst. delivery: ${rows[0].delivery_date}`:"";
        await sendMessage(phone,`📦 ${rows[0].order_id}\nStatus: ${s.label}${del}\n\n${s.eta}`,phoneNumberId);
        return;
      }
    }
  }
  // Auto-lookup by phone number
  const active = await getActiveOrder(phone);
  if (active) {
    const s = STATUS_MAP[active.status]||{label:active.status,eta:""};
    const del = active.delivery_date?`\nEst. delivery: ${active.delivery_date}`:"";
    await sendMessage(phone,`📦 ${active.order_id}\nStatus: ${s.label}${del}\nDate: ${active.date} | ${active.slot}\n\n${s.eta}`,phoneNumberId);
    return;
  }
  // Check last few orders including delivered
  try {
    const allOrders = await dbSelect("bookings",`phone=eq.${phone}&order=created_at.desc&limit=3`);
    if (allOrders.length) {
      const latest = allOrders[0];
      const s = STATUS_MAP[latest.status]||{label:latest.status,eta:""};
      await sendMessage(phone,`📦 Latest order: ${latest.order_id}\nStatus: ${s.label}\nDate: ${latest.date}\n\n${s.eta}\n\nFor older orders, share the order ID.`,phoneNumberId);
      return;
    }
  } catch {}
  session.step="tracking"; saveSession(phone,session);
  await sendMessage(phone,"Share your order ID (e.g. FW-1234):",phoneNumberId);
}

async function handleReschedule(phone, session, branch, phoneNumberId) {
  const active = await getActiveOrder(phone);
  if (!active) {
    await sendMessage(phone, "No active order to reschedule. Type *pickup* to book.", phoneNumberId);
    return;
  }
  if (["inprogress","outfordelivery","delivered","cancelled"].includes(active.status)) {
    await sendMessage(phone, `Order ${active.order_id} is ${STATUS_MAP[active.status]?.label} — it cannot be rescheduled at this stage.`, phoneNumberId);
    return;
  }
  session.booking.orderId    = active.order_id;
  session.booking.name       = active.name;
  session.booking.address    = active.address;
  session.booking.branch     = active.branch;
  session.booking.reschedule = true;
  session.step = "select_date";
  saveSession(phone, session);
  await sendMessage(phone, `Rescheduling order ${active.order_id}. Which new date works for you?`, phoneNumberId);
  await askDate(phone, phoneNumberId);
}

async function handleCancel(phone, session, rawText, branch, phoneNumberId) {
  const m = rawText.match(/FW-\d+/i);
  const active = await getActiveOrder(phone);
  const orderId = m ? m[0].toUpperCase() : active?.order_id;
  if (!orderId) { session.step="idle"; saveSession(phone,session); await sendMessage(phone,"No active order found. Type pickup to book.",phoneNumberId); return; }
  try {
    const rows = await dbSelect("bookings",`order_id=eq.${orderId}`);
    if (!rows.length) { await sendMessage(phone,"Order not found.",phoneNumberId); return; }
    if (["delivered","cancelled"].includes(rows[0].status)) { await sendMessage(phone,`Order ${orderId} is already ${STATUS_MAP[rows[0].status]?.label}.`,phoneNumberId); return; }
    await sendButtons(phone,`Cancel order ${orderId}?\nDate: ${rows[0].date} | ${rows[0].slot}`,
      [{id:`cc_${orderId}`,title:"Yes, Cancel"},{id:"no_cancel",title:"Keep it"}],phoneNumberId
    );
    session.step="confirm_cancel"; saveSession(phone,session);
  } catch { await sendMessage(phone,"Something went wrong. Please try again.",phoneNumberId); }
}

async function handleExpress(phone, branch, phoneNumberId) {
  const active = await getActiveOrder(phone);
  if (active?.status==="picked"||active?.status==="inprogress") {
    if (isTodayThursday()) { await sendMessage(phone,"Express is not available on Thursdays.",phoneNumberId); return; }
    await dbUpdate("bookings",`order_id=eq.${active.order_id}`,{express:true});
    await sendMessage(phone,`Express confirmed for order ${active.order_id}.\n\nReady in 120 minutes. Charges are 1.5x the standard price.`,phoneNumberId);
    await sendMessage(branch.admin,`Express requested\nOrder: ${active.order_id}\nName: ${active.name}\nPhone: +${active.phone}`,phoneNumberId);
    return;
  }
  if (active) { await sendMessage(phone,`Express can be requested after pickup. Current status: ${STATUS_MAP[active.status]?.label}`,phoneNumberId); return; }
  await sendMessage(phone,"Express is available after pickup. Type pickup to book.",phoneNumberId);
}

async function handleSameAsLast(phone, session, phoneNumberId) {
  const customer = await getCustomer(phone);
  const last     = await getLastOrder(phone);
  const active   = await getActiveOrder(phone);
  if (active&&active.status!=="cancelled"&&active.status!=="delivered") {
    await sendMessage(phone,`Order ${active.order_id} is already active. Please wait for delivery before booking again.`,phoneNumberId); return;
  }
  if (!last) { await sendMessage(phone,"No previous order found. Type pickup to book.",phoneNumberId); return; }
  session.booking.name    = customer?.name||last.name;
  session.booking.address = last.address;
  session.booking.branch  = last.branch||customer?.branch;
  saveSession(phone,session);
  await sendButtons(phone,`Same as last time.\n\nAddress: ${last.address}\n\nWhich day?`,
    [{id:"date_today",title:"Today"},{id:"date_tomorrow",title:"Tomorrow"},{id:"date_custom",title:"Another date"}],phoneNumberId
  );
  session.step="select_date"; saveSession(phone,session);
}

async function handlePayment(phone, session, branch, phoneNumberId) {
  const active   = await getActiveOrder(phone);
  const customer = await getCustomer(phone);
  if (!active) { await sendMessage(phone,"No active order found. Admin will confirm shortly.",phoneNumberId); return; }
  if (active.payment_status==="paid") { await sendMessage(phone,`Payment for order ${active.order_id} is already confirmed.`,phoneNumberId); return; }
  session.paymentOrderId = active.order_id;
  session.paymentAmount  = active.amount||0;
  session.step = "payment_method";
  saveSession(phone,session);
  await sendButtons(phone,
    `Payment noted for order ${active.order_id}${active.amount?` - Rs ${active.amount}`:"."}.\n\nHow did you pay?`,
    [{id:"pay_upi",title:"UPI / QR"},{id:"pay_cash",title:"Cash"}],phoneNumberId
  );
}

async function handleBookingIntent(phone, session, rawText, t, branch, phoneNumberId) {
  const customer = await getCustomer(phone);
  const active   = await getActiveOrder(phone);
  if (active&&active.status!=="cancelled"&&active.status!=="delivered"&&!session.allowAnotherBooking) {
    await sendButtons(phone,
      `You have an active order ${active.order_id} (${STATUS_MAP[active.status]?.label}).\n\nBook another pickup?`,
      [{id:"btn_book",title:"Yes, book another"},{id:"btn_track",title:"Track existing"}],phoneNumberId
    );
    return;
  }
  // Clear the bypass flag
  session.allowAnotherBooking = false;
  if (customer) {
    if (!session.booking.name)    session.booking.name    = customer.name;
    if (!session.booking.address) session.booking.address = customer.address;
    if (!session.booking.branch&&customer.branch) session.booking.branch = customer.branch;
    // Address confirmation for returning customers — only if not already in a step
    if (customer.address && !session.booking.date && !session.addressConfirmed && session.step === "idle") {
      session.step = "confirm_address";
      saveSession(phone, session);
      await sendButtons(phone,
        `Pick up from your saved address?\n\n📍 ${customer.address}`,
        [{id:"use_saved", title:"Yes, this address"}, {id:"update_details", title:"Different address"}],
        phoneNumberId
      );
      return;
    }
  }
  const hasTomorrow = has(t,"kal ","tomorrow","kal ko","udya");
  const hasToday    = has(t,"aaj ","today","abhi","aaj ko");
  const hasParso    = has(t,"parso","day after tomorrow","parsoon");
  const hasMorning  = has(t,"subah","morning","savere","sakali","10 am","11 am");
  const hasEvening  = has(t,"shaam","evening","sham","sandhyakal","5 pm","6 pm","7 pm");
  const DAY_NAMES = {
    sunday:0, ravivar:0, aaditwar:0, adiwar:0, robiwar:0,
    monday:1, somwar:1, somavar:1, somvaar:1,
    tuesday:2, mangalwar:2, mangalavar:2, mangalvaar:2,
    wednesday:3, budhwar:3, budhavar:3, budhvaar:3,
    thursday:4, guruvar:4, bruhaspativar:4, guruvaar:4,
    friday:5, shukrawar:5, shukravar:5, shukravaar:5,
    saturday:6, shaniwar:6, shanivar:6, shanivari:6, shanivaar:6,
  };
  function getNextDayDate(targetDay) { const d=new Date(); const diff=(targetDay-d.getDay()+7)%7||7; d.setDate(d.getDate()+diff); return formatDate(d); }
  let detectedDay = null;
  for (const [name,num] of Object.entries(DAY_NAMES)) { if (t.includes(name)){detectedDay=num;break;} }
  if (hasParso) { session.booking.date=getDayAfter(); }
  else if (hasTomorrow) {
    if (isTomorrowThursday()) { await sendMessage(phone,"Tomorrow is Thursday - we are closed.",phoneNumberId); await askDate(phone,phoneNumberId); return; }
    session.booking.date=getTomorrow();
  } else if (hasToday) {
    if (isTodayThursday()) { await sendMessage(phone,"Today is Thursday - we are closed.",phoneNumberId); await askDate(phone,phoneNumberId); return; }
    session.booking.date=getToday();
  } else if (detectedDay!==null) {
    if (detectedDay===4) { await sendMessage(phone,"We are closed on Thursdays.",phoneNumberId); await askDate(phone,phoneNumberId); return; }
    session.booking.date=getNextDayDate(detectedDay);
  }
  if (hasMorning)      session.booking.slot="Morning (10 AM - 1 PM)";
  else if (hasEvening) session.booking.slot="Evening (5 PM - 8 PM)";
  const bk = session.booking;
  if (!bk.name) {
    await sendMessage(phone,"Welcome to Washkart. What is your name?",phoneNumberId);
    session.step="get_name"; saveSession(phone,session);
    await logLead(phone,"booking_started",rawText,branch.slug);
    setDropoffTimer(phone,null,"name step",branch,phoneNumberId); return;
  }
  if (!bk.address) {
    await sendMessage(phone,`${bk.name}, what is your pickup address?`,phoneNumberId);
    session.step="get_address"; saveSession(phone,session);
    setDropoffTimer(phone,bk.name,"address step",branch,phoneNumberId); return;
  }
  if (!bk.branch) {
    const detected = detectBranchFromAddress(bk.address);
    if (detected) { bk.branch=detected; }
    else { session.step="select_branch"; saveSession(phone,session); await askBranch(phone,phoneNumberId); return; }
  }
  if (!bk.date) { await askDate(phone,phoneNumberId); session.step="select_date"; saveSession(phone,session); return; }
  if (!bk.slot) { await askSlot(phone,phoneNumberId,bk.date); session.step="select_slot"; saveSession(phone,session); return; }
  if (customer) {
    clearDropoffTimer(phone);
    await confirmBooking(phone,bk,getBranchBySlug(bk.branch)||branch,phoneNumberId);
    session.booking={}; saveSession(phone,session);
  } else {
    await showBookingConfirm(phone,session,phoneNumberId);
    setNudgeTimer(phone,phoneNumberId); saveSession(phone,session);
  }
}

// REMINDERS
async function sendReminders() {
  try {
    const today = getToday();
    const rows  = await dbSelect("bookings",`date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const hour  = new Date().getHours();
    for (const b of rows) {
      if ((b.slot?.includes("Morning")&&hour===8)||(b.slot?.includes("Evening")&&hour===15)) {
        const brSlug = b.branch||"bavdhan";
        const numId  = getBranchNumId(brSlug);
        const br     = getBranchBySlug(brSlug)||DEFAULT_BRANCH;
        await sendMessage(b.phone,`Pickup reminder - Washkart ${br.name}\n\nHi ${b.name}, your pickup is today.\nSlot: ${b.slot}\nAddress: ${b.address}\nOrder: ${b.order_id}\n\nTo cancel: type cancel`,numId);
        await dbUpdate("bookings",`order_id=eq.${b.order_id}`,{reminder_sent:true});
      }
    }
  } catch (e) { console.error("Reminder error:", e.message); }
}
setInterval(sendReminders, 30*60*1000);

// Overdue check — runs every hour, alerts at 9 AM if overdue orders exist
async function checkOverdueOrders() {
  const now = new Date();
  if (now.getHours() !== 9) return;
  try {
    const all = await dbSelect("bookings", "status=neq.delivered&status=neq.cancelled&order=created_at.desc");
    const overdue = all.filter(b => {
      if (!b.delivery_date) return false;
      const parts = b.delivery_date.match(/(\d+)\s+(\w+)/);
      if (!parts) return false;
      try {
        const d = new Date(`${parts[2]} ${parts[1]} ${now.getFullYear()}`);
        d.setHours(0,0,0,0);
        const today = new Date(); today.setHours(0,0,0,0);
        return d < today;
      } catch { return false; }
    });
    if (overdue.length > 0) {
      const list = overdue.map(b => `${b.order_id} - ${b.name} (${b.delivery_date})`).join("\n");
      const msg = `Overdue orders alert - ${overdue.length} order(s) past delivery date:\n\n${list}\n\nPlease follow up with customers.`;
      await sendMessage(OWNER_NUMBER, msg, "1136879376186203");
    }
  } catch (e) { console.error("Overdue check error:", e.message); }
}
setInterval(checkOverdueOrders, 60 * 60 * 1000);

// Rates-but-no-booking tracker
const ratesViewedAt = {};
async function trackRatesNoBooking(phone, branch, phoneNumberId) {
  ratesViewedAt[phone] = Date.now();
  setTimeout(async () => {
    // Check if they booked within 15 min
    const active = await getActiveOrder(phone).catch(() => null);
    const lead   = await dbSelect("leads", `phone=eq.${phone}`).catch(() => []);
    const stage  = lead[0]?.stage;
    if (stage !== "converted" && !active) {
      const br = branch || DEFAULT_BRANCH;
      await sendMessage(OWNER_NUMBER,
        `Warm lead - ${br.name}\n\nPhone: +${phone}\nChecked rates but did not book in 15 min.\n\nConsider following up.`,
        phoneNumberId || "1136879376186203"
      );
      await logLead(phone, "dropped", "viewed rates, no booking", br.slug, phoneNumberId);
    }
  }, 15 * 60 * 1000);
}

// Weekly summary
async function sendWeeklySummary() {
  const now = new Date();
  if (now.getDay()!==1||now.getHours()!==9) return;
  try {
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate()-7);
    const all = await dbSelect("bookings",`created_at=gte.${weekAgo.toISOString()}&order=created_at.desc`);
    const delivered = all.filter(b=>b.status==="delivered");
    const collected = delivered.filter(b=>b.payment_status==="paid").reduce((s,b)=>s+(b.amount||0),0);
    const pending   = delivered.filter(b=>b.payment_status!=="paid").reduce((s,b)=>s+(b.amount||0),0);
    const ratings   = await dbSelect("ratings",`created_at=gte.${weekAgo.toISOString()}`);
    const avg       = ratings.length?(ratings.reduce((s,r)=>s+(r.rating||0),0)/ratings.length).toFixed(1):"N/A";
    const summary   = `Washkart - Weekly Summary\n\nBookings: ${all.length}\nDelivered: ${delivered.length}\nCollected: Rs ${collected}\nPending payments: Rs ${pending}\nAvg rating: ${avg}/5`;
    for (const br of Object.values(BRANCHES)) {
      if (br.admin) await sendMessage(br.admin,summary,getBranchNumId(br.slug));
    }
  } catch (e) { console.error("Weekly summary error:", e.message); }
}
setInterval(sendWeeklySummary, 60*60*1000);

// WEBHOOK
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});
app.post("/webhook", async (req, res) => {
  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const messages = value?.messages;
    const phoneNumberId = value?.metadata?.phone_number_id||"1136879376186203";
    if (!messages?.length) return res.sendStatus(200);
    const msg = messages[0];
    if (processedMessages.has(msg.id)) return res.sendStatus(200);
    processedMessages.add(msg.id);
    setTimeout(()=>processedMessages.delete(msg.id),60000);
    const phone = normalizePhone(msg.from);
    let text = "";
    if      (msg.type==="text")        text = msg.text.body;
    else if (msg.type==="audio")       text = "__audio__";
    else if (msg.type==="image")       text = "__image__";
    else if (msg.type==="video")       text = "__video__";
    else if (msg.type==="document")    text = "__document__";
    else if (msg.type==="sticker")     text = "__sticker__";
    else if (msg.type==="interactive") {
      text = msg.interactive.type==="button_reply"
        ? msg.interactive.button_reply.id
        : msg.interactive.list_reply.id;
    }
    if (text) enqueueMessage(phone,text,phoneNumberId);
    res.sendStatus(200);
  } catch (err) { console.error(err?.response?.data||err.message); res.sendStatus(200); }
});

// DASHBOARD API
app.get("/bookings", async (req,res) => {
  try {
    const {branch,phone} = req.query;
    const filters = ["order=created_at.desc"];
    if (branch&&branch!=="all") filters.push(`branch=eq.${branch}`);
    if (phone) filters.push(`phone=eq.${normalizePhone(phone)}`);
    res.json(await dbSelect("bookings",filters.join("&")));
  } catch (e) { res.status(500).json({error:e.message}); }
});

app.post("/bookings", async (req,res) => {
  try {
    const {name,phone,address,date,slot,source,notes,service_type,branch} = req.body;
    if (!name||!phone) return res.status(400).json({error:"Name and phone required"});
    const isWalkIn   = source==="walkin";
    if (!isWalkIn&&(!address||!date||!slot)) return res.status(400).json({error:"Missing required fields"});
    const orderId    = genOrderId();
    const normPhone  = normalizePhone(phone);
    const branchSlug = branch||"bavdhan";
    const br         = getBranchBySlug(branchSlug)||DEFAULT_BRANCH;
    const numId      = getBranchNumId(branchSlug);
    await dbInsert("bookings",{
      order_id:orderId,name,phone:normPhone,
      address:address||"Walk-in (In-store)",
      date:date||getToday(),slot:slot||"Walk-in",
      status:isWalkIn?"picked":"pending",
      reminder_sent:false,source:source||"walkin",
      branch:branchSlug,notes:notes||"",
      amount:0,payment_status:"unpaid",payment_method:"",
      ...(service_type?{service_type}:{}),
    });
    if (address) await saveCustomer(normPhone,name,address,branchSlug);
    await sendMessage(br.admin,
      `New Booking [${source||"Walk-in"}] - ${br.name}\n\nOrder: ${orderId}\nName: ${name}\nPhone: +${normPhone}\nAddress: ${address||"Walk-in"}\nDate: ${date||getToday()}\nSlot: ${slot||"Walk-in"}${notes?`\nNotes: ${notes}`:""}`,
      numId
    );
    res.json({success:true,order_id:orderId});
  } catch (e) { res.status(500).json({error:e.message}); }
});

app.patch("/bookings/:orderId", async (req,res) => {
  try {
    const {status,service_type,express,delivery_date,notes,amount,payment_status,payment_method,send_payment_reminder} = req.body;
    const orderId = req.params.orderId;

    // Fetch current order BEFORE update to detect status change
    const prevRows = await dbSelect("bookings",`order_id=eq.${orderId}`).catch(()=>[]);
    const prevOrder = prevRows[0];
    const prevStatus = prevOrder?.status;

    const updateData = {};
    if (status         !==undefined) updateData.status         = status;
    if (service_type   !==undefined) updateData.service_type   = service_type;
    if (express        !==undefined) updateData.express        = express;
    if (delivery_date)               updateData.delivery_date  = delivery_date;
    if (notes          !==undefined) updateData.notes          = notes;
    if (payment_status !==undefined) updateData.payment_status = payment_status;
    if (payment_method !==undefined) updateData.payment_method = payment_method;
    if (payment_status==="paid")     updateData.payment_date   = new Date().toISOString();
    // Only update amount if explicitly provided and > 0 (never wipe existing amount)
    if (amount!==undefined && amount > 0) updateData.amount = amount;
    // Auto calc delivery date when service type set
    if (service_type&&!delivery_date) updateData.delivery_date = calcDeliveryDate(service_type,express||false);
    // Auto move to inprogress when amount set on pending/picked order
    if (amount!==undefined&&amount>0&&prevStatus&&["pending","picked"].includes(prevStatus)) {
      updateData.status = "inprogress";
    }

    await dbUpdate("bookings",`order_id=eq.${orderId}`,updateData);
    const rows = await dbSelect("bookings",`order_id=eq.${orderId}`);
    const b    = rows[0];
    const brSlug = b?.branch||"bavdhan";
    const br   = getBranchBySlug(brSlug)||DEFAULT_BRANCH;
    let numId = getBranchNumId(brSlug);
    if (numId === "BANER_NUMBER_ID") numId = "1136879376186203"; // Baner not live yet
    const finalStatus = updateData.status||status;
    const statusChanged = finalStatus && finalStatus !== prevStatus;
    console.log(`[patch] ${orderId} ${prevStatus}→${finalStatus} changed:${statusChanged}`);

    const amountLine  = b?.amount?`\nBill: Rs ${b.amount} - payable via UPI QR or cash.`:"";
    const msgs = {
      picked:      `🚗 Picked up!\n\n${b?.service_type?`Service: ${b.service_type.charAt(0).toUpperCase()+b.service_type.slice(1)}\n`:""}${updateData.delivery_date?`Expected delivery: ${updateData.delivery_date}\n`:""}\nOrder: ${orderId}`,
      inprogress:  `🫧 Cleaning started!\n\n${updateData.delivery_date?`Expected delivery: ${updateData.delivery_date}\n`:""}Your clothes are being carefully cleaned.\nOrder: ${orderId}`,
      outfordelivery: `🚚 Your order is on the way!\n\nFresh clothes arriving soon.${amountLine}\nOrder: ${orderId}`,
      delivered:   `✅ Delivered!\n\nYour clothes are back — fresh and clean.${amountLine}\n\nPayment done? Reply *paid*.`,
    };
    if (msgs[finalStatus]&&b?.phone&&statusChanged) {
      await sendMessage(b.phone,msgs[finalStatus],numId);
      // Send express button after picked up
      if (finalStatus==="picked") {
        setTimeout(async()=>{
          await sendButtons(b.phone,
            "Need your clothes faster?",
            [{id:"express_yes",title:"⚡ Express (120 min)"},{id:"express_no",title:"3 days is fine"}],
            numId
          );
        }, 1500);
      }
      if (finalStatus==="delivered") {
        setTimeout(async()=>{
          await sendButtons(b.phone,"How was your experience? ⭐",
            [{id:"rating_excellent",title:"Excellent"},{id:"rating_good",title:"Good"},{id:"rating_poor",title:"Needs work"}],numId
          );
          sessionCache[b.phone]=sessionCache[b.phone]||{step:"idle",booking:{},history:[]};
          sessionCache[b.phone].step="feedback";
          saveSession(b.phone,sessionCache[b.phone]);
        },2000);
      }
    }
    // Send QR on out for delivery
    if (finalStatus==="outfordelivery"&&br.qrMediaId&&b?.phone) {
      await delay(600);
      await sendImage(b.phone,br.qrMediaId,`Scan to pay - Washkart ${br.name}`,numId);
    }
    // Manual payment reminder
    if (send_payment_reminder&&b?.phone&&b?.amount) {
      await sendMessage(b.phone,`Payment reminder - Washkart ${br.name}\n\nHi ${b.name}, payment of Rs ${b.amount} for order ${orderId} is pending.\n\nOur delivery agent carries a QR code. You can also pay cash.\n\nAlready paid? Reply paid.`,numId);
      if (br.qrMediaId) { await delay(500); await sendImage(b.phone,br.qrMediaId,`Scan to pay - Rs ${b.amount}`,numId); }
    }
    res.json({success:true,delivery_date:updateData.delivery_date,status:finalStatus});
  } catch (e) { res.status(500).json({error:e.message}); }
});

app.delete("/bookings/:orderId", async (req,res) => {
  try { await dbDelete("bookings",`order_id=eq.${req.params.orderId}`); res.json({success:true}); }
  catch (e) { res.status(500).json({error:e.message}); }
});

app.post("/send-message", async (req,res) => {
  try {
    const {phone, message, branch} = req.body;
    if (!phone||!message) return res.status(400).json({error:"Phone and message required"});
    const normalized = normalizePhone(phone);
    let numId = getBranchNumId(branch||"bavdhan");
    // Fallback to Bavdhan if Baner not yet configured
    if (numId === "BANER_NUMBER_ID") numId = "1136879376186203";
    console.log(`[send-message] to:${normalized} branch:${branch||"bavdhan"} numId:${numId}`);
    const ok = await sendMessage(normalized, message, numId, true); // throwOnError=true
    res.json({success:ok});
  } catch (e) {
    console.error("[send-message error]", e.message);
    res.status(500).json({error: e.message, hint: "Check WHATSAPP_TOKEN in Render env vars"});
  }
});

app.get("/customers",      async(req,res)=>{ try{ const {branch}=req.query; const f=branch&&branch!=="all"?`branch=eq.${branch}&order=created_at.desc`:"order=created_at.desc"; res.json(await dbSelect("customers",f)); }catch(e){res.status(500).json({error:e.message});} });
app.get("/ratings",        async(req,res)=>{ try{ const {branch}=req.query; const f=branch&&branch!=="all"?`branch=eq.${branch}&order=created_at.desc`:"order=created_at.desc"; res.json(await dbSelect("ratings",f)); }catch(e){res.status(500).json({error:e.message});} });
app.get("/leads",          async(req,res)=>{ try{ const {branch}=req.query; const f=branch&&branch!=="all"?`branch=eq.${branch}&order=updated_at.desc`:"order=updated_at.desc"; res.json(await dbSelect("leads",f)); }catch(e){res.status(500).json({error:e.message});} });
app.get("/conversations",  async(req,res)=>{ try{ const {phone}=req.query; if(phone){const rows=await dbSelect("sessions",`phone=eq.${normalizePhone(phone)}`);res.json(rows[0]||{});}else{const rows=await dbSelect("sessions","order=updated_at.desc&limit=100");res.json(rows);} }catch(e){res.status(500).json({error:e.message});} });
app.post("/takeover",      async(req,res)=>{ try{ const {phone,active}=req.body; const num=normalizePhone(phone); if(!sessionCache[num])sessionCache[num]={step:"idle",booking:{},history:[]}; sessionCache[num].takeoverActive=!!active; res.json({success:true,takeover:!!active}); }catch(e){res.status(500).json({error:e.message});} });
app.get("/dashboard",      (req,res)=>res.sendFile(path.join(__dirname,"dashboard.html")));
app.get("/ping", (req,res)=>res.json({
  status:"ok",
  time: new Date().toISOString(),
  token: TOKEN ? `${TOKEN.slice(0,10)}...${TOKEN.slice(-6)}` : "MISSING",
  branch: DEFAULT_BRANCH.name,
  phoneNumberId: Object.keys(BRANCHES)[0],
}));

// Test message endpoint — send test to yourself
app.get("/test-send", async (req,res)=>{ 
  const to = req.query.to || "919552552167";
  try {
    const result = await axios.post(
      `https://graph.facebook.com/v25.0/1136879376186203/messages`,
      { messaging_product:"whatsapp", to, type:"text", text:{body:"Washkart bot test message. If you see this, sending works!"} },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type":"application/json" } }
    );
    res.json({success:true, data: result.data});
  } catch(e) {
    res.json({success:false, error: e?.response?.data || e.message, status: e?.response?.status});
  }
});
app.get("/",               (req,res)=>res.send("Washkart Bot running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Washkart Bot running on port ${PORT}`));
