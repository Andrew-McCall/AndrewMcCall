// One hundred short sentences, each in a different language and written in that
// language's own script. `dir="auto"` on the sentence lets the browser lay out
// the right-to-left scripts (Arabic, Hebrew, Thaana, ...) correctly.

type Line = {
  lang: string; // language name, as identified
  code: string; // BCP-47-ish tag, shown as a small badge
  text: string; // the sentence, in its native script
  en: string; // English translation
};

// Where practical the sentence is the same thought — "I am reading a good
// book" — so the grammar and script differ while the meaning stays fixed.
const LINES: Line[] = [
  { lang: "English", code: "en", text: "I am reading a good book.", en: "I am reading a good book." },
  { lang: "Spanish", code: "es", text: "Estoy leyendo un buen libro.", en: "I am reading a good book." },
  { lang: "French", code: "fr", text: "Je lis un bon livre.", en: "I am reading a good book." },
  { lang: "German", code: "de", text: "Ich lese ein gutes Buch.", en: "I am reading a good book." },
  { lang: "Italian", code: "it", text: "Sto leggendo un buon libro.", en: "I am reading a good book." },
  { lang: "Portuguese", code: "pt", text: "Estou lendo um bom livro.", en: "I am reading a good book." },
  { lang: "Catalan", code: "ca", text: "Estic llegint un bon llibre.", en: "I am reading a good book." },
  { lang: "Romanian", code: "ro", text: "Citesc o carte bună.", en: "I am reading a good book." },
  { lang: "Dutch", code: "nl", text: "Ik lees een goed boek.", en: "I am reading a good book." },
  { lang: "Afrikaans", code: "af", text: "Ek lees 'n goeie boek.", en: "I am reading a good book." },
  { lang: "Danish", code: "da", text: "Jeg læser en god bog.", en: "I am reading a good book." },
  { lang: "Norwegian", code: "no", text: "Jeg leser en god bok.", en: "I am reading a good book." },
  { lang: "Swedish", code: "sv", text: "Jag läser en bra bok.", en: "I am reading a good book." },
  { lang: "Icelandic", code: "is", text: "Ég er að lesa góða bók.", en: "I am reading a good book." },
  { lang: "Finnish", code: "fi", text: "Luen hyvää kirjaa.", en: "I am reading a good book." },
  { lang: "Estonian", code: "et", text: "Ma loen head raamatut.", en: "I am reading a good book." },
  { lang: "Hungarian", code: "hu", text: "Egy jó könyvet olvasok.", en: "I am reading a good book." },
  { lang: "Polish", code: "pl", text: "Czytam dobrą książkę.", en: "I am reading a good book." },
  { lang: "Czech", code: "cs", text: "Čtu dobrou knihu.", en: "I am reading a good book." },
  { lang: "Slovak", code: "sk", text: "Čítam dobrú knihu.", en: "I am reading a good book." },
  { lang: "Slovenian", code: "sl", text: "Berem dobro knjigo.", en: "I am reading a good book." },
  { lang: "Croatian", code: "hr", text: "Čitam dobru knjigu.", en: "I am reading a good book." },
  { lang: "Bosnian", code: "bs", text: "Čitam zanimljivu knjigu.", en: "I am reading an interesting book." },
  { lang: "Serbian", code: "sr", text: "Читам добру књигу.", en: "I am reading a good book." },
  { lang: "Bulgarian", code: "bg", text: "Чета добра книга.", en: "I am reading a good book." },
  { lang: "Macedonian", code: "mk", text: "Читам добра книга.", en: "I am reading a good book." },
  { lang: "Ukrainian", code: "uk", text: "Я читаю гарну книжку.", en: "I am reading a good book." },
  { lang: "Russian", code: "ru", text: "Я читаю хорошую книгу.", en: "I am reading a good book." },
  { lang: "Belarusian", code: "be", text: "Я чытаю добрую кнігу.", en: "I am reading a good book." },
  { lang: "Lithuanian", code: "lt", text: "Skaitau gerą knygą.", en: "I am reading a good book." },
  { lang: "Latvian", code: "lv", text: "Es lasu labu grāmatu.", en: "I am reading a good book." },
  { lang: "Greek", code: "el", text: "Διαβάζω ένα καλό βιβλίο.", en: "I am reading a good book." },
  { lang: "Turkish", code: "tr", text: "İyi bir kitap okuyorum.", en: "I am reading a good book." },
  { lang: "Azerbaijani", code: "az", text: "Yaxşı bir kitab oxuyuram.", en: "I am reading a good book." },
  { lang: "Kazakh", code: "kk", text: "Мен жақсы кітап оқып жатырмын.", en: "I am reading a good book." },
  { lang: "Uzbek", code: "uz", text: "Men yaxshi kitob o'qiyapman.", en: "I am reading a good book." },
  { lang: "Kyrgyz", code: "ky", text: "Мен жакшы китеп окуп жатам.", en: "I am reading a good book." },
  { lang: "Tajik", code: "tg", text: "Ман китоби хубе мехонам.", en: "I am reading a good book." },
  { lang: "Mongolian", code: "mn", text: "Би сайн ном уншиж байна.", en: "I am reading a good book." },
  { lang: "Armenian", code: "hy", text: "Ես կարդում եմ լավ գիրք։", en: "I am reading a good book." },
  { lang: "Georgian", code: "ka", text: "მე ვკითხულობ კარგ წიგნს.", en: "I am reading a good book." },
  { lang: "Hebrew", code: "he", text: "אני קורא ספר טוב.", en: "I am reading a good book." },
  { lang: "Arabic", code: "ar", text: "أقرأ كتابًا جيدًا.", en: "I am reading a good book." },
  { lang: "Persian", code: "fa", text: "من یک کتاب خوب می‌خوانم.", en: "I am reading a good book." },
  { lang: "Urdu", code: "ur", text: "میں ایک اچھی کتاب پڑھ رہا ہوں۔", en: "I am reading a good book." },
  { lang: "Pashto", code: "ps", text: "زه یو ښه کتاب لولم.", en: "I am reading a good book." },
  { lang: "Kurdish (Kurmanji)", code: "ku", text: "Ez pirtûkeke baş dixwînim.", en: "I am reading a good book." },
  { lang: "Hindi", code: "hi", text: "मैं एक अच्छी किताब पढ़ रहा हूँ।", en: "I am reading a good book." },
  { lang: "Bengali", code: "bn", text: "আমি একটি ভালো বই পড়ছি।", en: "I am reading a good book." },
  { lang: "Punjabi", code: "pa", text: "ਮੈਂ ਇੱਕ ਚੰਗੀ ਕਿਤਾਬ ਪੜ੍ਹ ਰਿਹਾ ਹਾਂ।", en: "I am reading a good book." },
  { lang: "Gujarati", code: "gu", text: "હું એક સારું પુસ્તક વાંચી રહ્યો છું.", en: "I am reading a good book." },
  { lang: "Marathi", code: "mr", text: "मी एक चांगले पुस्तक वाचत आहे.", en: "I am reading a good book." },
  { lang: "Nepali", code: "ne", text: "म एउटा राम्रो किताब पढ्दै छु।", en: "I am reading a good book." },
  { lang: "Odia", code: "or", text: "ମୁଁ ଏକ ଭଲ ବହି ପଢୁଛି।", en: "I am reading a good book." },
  { lang: "Tamil", code: "ta", text: "நான் ஒரு நல்ல புத்தகத்தைப் படிக்கிறேன்.", en: "I am reading a good book." },
  { lang: "Telugu", code: "te", text: "నేను ఒక మంచి పుస్తకం చదువుతున్నాను.", en: "I am reading a good book." },
  { lang: "Kannada", code: "kn", text: "ನಾನು ಒಂದು ಒಳ್ಳೆಯ ಪುಸ್ತಕವನ್ನು ಓದುತ್ತಿದ್ದೇನೆ.", en: "I am reading a good book." },
  { lang: "Malayalam", code: "ml", text: "ഞാൻ ഒരു നല്ല പുസ്തകം വായിക്കുന്നു.", en: "I am reading a good book." },
  { lang: "Sinhala", code: "si", text: "මම හොඳ පොතක් කියවනවා.", en: "I am reading a good book." },
  { lang: "Thai", code: "th", text: "ฉันกำลังอ่านหนังสือดีๆ อยู่", en: "I am reading a good book." },
  { lang: "Lao", code: "lo", text: "ຂ້ອຍກຳລັງອ່ານປຶ້ມດີໆ", en: "I am reading a good book." },
  { lang: "Khmer", code: "km", text: "ខ្ញុំកំពុងអានសៀវភៅល្អ។", en: "I am reading a good book." },
  { lang: "Burmese", code: "my", text: "ကျွန်တော် ကောင်းတဲ့စာအုပ်တစ်အုပ် ဖတ်နေတယ်။", en: "I am reading a good book." },
  { lang: "Tibetan", code: "bo", text: "ངས་དེབ་ཡག་པོ་ཞིག་ཀློག་བཞིན་ཡོད།", en: "I am reading a good book." },
  { lang: "Dhivehi", code: "dv", text: "އަހަރެން ރަނގަޅު ފޮތެއް ކިޔަނީ.", en: "I am reading a good book." },
  { lang: "Chinese (Simplified)", code: "zh-Hans", text: "我在读一本好书。", en: "I am reading a good book." },
  { lang: "Chinese (Traditional)", code: "zh-Hant", text: "我在讀一本好書。", en: "I am reading a good book." },
  { lang: "Japanese", code: "ja", text: "私は良い本を読んでいます。", en: "I am reading a good book." },
  { lang: "Korean", code: "ko", text: "나는 좋은 책을 읽고 있다.", en: "I am reading a good book." },
  { lang: "Vietnamese", code: "vi", text: "Tôi đang đọc một cuốn sách hay.", en: "I am reading a good book." },
  { lang: "Indonesian", code: "id", text: "Saya sedang membaca buku yang bagus.", en: "I am reading a good book." },
  { lang: "Malay", code: "ms", text: "Saya sedang membaca sebuah buku yang baik.", en: "I am reading a good book." },
  { lang: "Filipino (Tagalog)", code: "tl", text: "Nagbabasa ako ng isang magandang libro.", en: "I am reading a good book." },
  { lang: "Hawaiian", code: "haw", text: "Ke heluhelu nei au i kekahi puke maikaʻi.", en: "I am reading a good book." },
  { lang: "Māori", code: "mi", text: "Kei te pānui ahau i tētahi pukapuka pai.", en: "I am reading a good book." },
  { lang: "Samoan", code: "sm", text: "O lo'o ou faitau i se tusi lelei.", en: "I am reading a good book." },
  { lang: "Tongan", code: "to", text: "ʻOku ou lau ha tohi lelei.", en: "I am reading a good book." },
  { lang: "Fijian", code: "fj", text: "Au wilika tiko e dua na ivola vinaka.", en: "I am reading a good book." },
  { lang: "Malagasy", code: "mg", text: "Mamaky boky tsara aho.", en: "I am reading a good book." },
  { lang: "Swahili", code: "sw", text: "Ninasoma kitabu kizuri.", en: "I am reading a good book." },
  { lang: "Zulu", code: "zu", text: "Ngifunda incwadi enhle.", en: "I am reading a good book." },
  { lang: "Xhosa", code: "xh", text: "Ndifunda incwadi entle.", en: "I am reading a good book." },
  { lang: "Shona", code: "sn", text: "Ndiri kuverenga bhuku rakanaka.", en: "I am reading a good book." },
  { lang: "Yoruba", code: "yo", text: "Mo ń ka ìwé tó dára.", en: "I am reading a good book." },
  { lang: "Igbo", code: "ig", text: "Ana m agụ akwụkwọ mara mma.", en: "I am reading a good book." },
  { lang: "Hausa", code: "ha", text: "Ina karanta littafi mai kyau.", en: "I am reading a good book." },
  { lang: "Somali", code: "so", text: "Waxaan akhrinayaa buug wanaagsan.", en: "I am reading a good book." },
  { lang: "Amharic", code: "am", text: "ጥሩ መጽሐፍ እያነበብኩ ነው።", en: "I am reading a good book." },
  { lang: "Welsh", code: "cy", text: "Rwy'n darllen llyfr da.", en: "I am reading a good book." },
  { lang: "Irish", code: "ga", text: "Táim ag léamh leabhar maith.", en: "I am reading a good book." },
  { lang: "Scottish Gaelic", code: "gd", text: "Tha mi a' leughadh leabhar math.", en: "I am reading a good book." },
  { lang: "Breton", code: "br", text: "Emaon o lenn ul levr mat.", en: "I am reading a good book." },
  { lang: "Basque", code: "eu", text: "Liburu on bat irakurtzen ari naiz.", en: "I am reading a good book." },
  { lang: "Galician", code: "gl", text: "Estou a ler un bo libro.", en: "I am reading a good book." },
  { lang: "Maltese", code: "mt", text: "Qed naqra ktieb tajjeb.", en: "I am reading a good book." },
  { lang: "Albanian", code: "sq", text: "Po lexoj një libër të mirë.", en: "I am reading a good book." },
  { lang: "Luxembourgish", code: "lb", text: "Ech liesen e gutt Buch.", en: "I am reading a good book." },
  { lang: "Faroese", code: "fo", text: "Eg lesi eina góða bók.", en: "I am reading a good book." },
  { lang: "West Frisian", code: "fy", text: "Ik lês in goed boek.", en: "I am reading a good book." },
  { lang: "Yiddish", code: "yi", text: "איך לייען אַ גוט בוך.", en: "I am reading a good book." },
  { lang: "Haitian Creole", code: "ht", text: "M ap li yon bon liv.", en: "I am reading a good book." },
  { lang: "Esperanto", code: "eo", text: "Mi legas bonan libron.", en: "I am reading a good book." },
  { lang: "Latin", code: "la", text: "Librum bonum lego.", en: "I am reading a good book." },
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const renderCard = (line: Line, i: number) => `
<li class="border border-green-900/40 bg-black/40 p-4 flex flex-col gap-2">
  <div class="flex items-baseline justify-between gap-2">
    <span class="text-green-500 font-bold">${escapeHtml(line.lang)}</span>
    <span class="text-[10px] text-green-700 border border-green-900 px-1.5 py-0.5 uppercase tracking-wider">${escapeHtml(line.code)}</span>
  </div>
  <p dir="auto" lang="${escapeHtml(line.code)}" class="text-xl text-green-50 leading-relaxed">${escapeHtml(line.text)}</p>
  <p class="text-xs text-green-800 italic">${String(i + 1).padStart(3, "0")} · ${escapeHtml(line.en)}</p>
</li>`;

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen bg-[#050505] text-green-500 font-mono p-4">

<a href="/secret" title="Back to the secret menu" class="mb-2 mt-4">
<h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
100 Languages
</h1>
</a>

<p class="text-green-700 text-sm mb-6 text-center">One hundred grammatical sentences — each language in its own script.</p>

<input id="lang-search" type="search" placeholder="Filter by language, script, or code…"
  class="w-full max-w-lg mb-6 bg-black border border-green-900 px-4 py-2 text-green-200 placeholder:text-green-900
         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500" />

<ul id="lang-list" class="w-full max-w-4xl grid grid-cols-1 sm:grid-cols-2 gap-3">
${LINES.map(renderCard).join("\n")}
</ul>

<p id="lang-empty" class="hidden text-green-800 italic mt-8">No language matches that.</p>
</div>
`;

  const list = app.querySelector<HTMLUListElement>("#lang-list")!;
  const empty = app.querySelector<HTMLParagraphElement>("#lang-empty")!;
  const items = Array.from(list.children) as HTMLLIElement[];

  // Filter on language name, code, native text, or translation.
  app.querySelector<HTMLInputElement>("#lang-search")!.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    let shown = 0;
    items.forEach((li, i) => {
      const l = LINES[i];
      const hit =
        !q ||
        l.lang.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q) ||
        l.text.toLowerCase().includes(q) ||
        l.en.toLowerCase().includes(q);
      li.classList.toggle("hidden", !hit);
      if (hit) shown++;
    });
    empty.classList.toggle("hidden", shown > 0);
  });
};
