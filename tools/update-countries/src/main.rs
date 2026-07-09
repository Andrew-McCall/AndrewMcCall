//! Regenerates the backend's country data from Natural Earth:
//!
//!   * `backend/assets/countries/<slug>.svg` — one Web Mercator outline per
//!     territory, rendered with `am-shapefile` from the 10m admin-0 countries
//!     shapefile (Ukraine-POV variant).
//!   * the `countries` and `cities` Postgres tables — display name,
//!     population (admin-0 `POP_EST`), GDP (admin-0 `GDP_MD`, millions of
//!     current USD), ISO 3166-1 alpha-2 code (for flag CDN links), and each
//!     territory's top cities with their coordinates projected into that
//!     SVG's viewBox and the capital marked `capital`. Every run applies the
//!     backend migrations and then replaces both tables' contents in one
//!     transaction.
//!
//! Cities come from Natural Earth populated places (top 3 by population plus
//! the admin-0 capital); [`MANUAL_CITIES`] fills in the small territories the
//! dataset does not cover. Israel is excluded per [`EXCLUDE`].
//!
//! Run with `cargo run --release [-- --skip-db]` in `tools/update-countries/`.
//! Source data is downloaded (curl + unzip) into `.cache/` on first use; the
//! database is located via `DATABASE_DSN` (or the `DATABASE_*` variables),
//! read from the environment or `backend/.env`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use am_shapefile::dbf::DbfValue;
use am_shapefile::geometry::for_each_point;
use am_shapefile::{read_shapefile, Point, Projection, Shape, Shapefile, SvgOptions};
use sqlx::{Connection, PgConnection};

const NE_BASE: &str = "https://naciscdn.org/naturalearth/10m/cultural";
const ADMIN0: &str = "ne_10m_admin_0_countries_ukr";
const PLACES: &str = "ne_10m_populated_places_simple";

const WIDTH: f64 = 1000.0;
const PROJECTION: Projection = Projection::WebMercator;

/// Admin-0 `NAME` values to leave out of the generated assets entirely.
const EXCLUDE: &[&str] = &["Israel"];

/// Display name and capital per admin-0 feature, keyed by the sanitized
/// `NAME` (underscores for spaces, trailing dots trimmed — see
/// [`sanitize_stem`]). Names expand the Natural Earth abbreviations; a `None`
/// capital means the territory has none.
const COUNTRIES: &[(&str, &str, Option<&str>)] = &[
    ("Afghanistan", "Afghanistan", Some("Kabul")),
    ("Akrotiri", "Akrotiri", Some("Episkopi Cantonment")),
    ("Albania", "Albania", Some("Tirana")),
    ("Algeria", "Algeria", Some("Algiers")),
    ("American_Samoa", "American Samoa", Some("Pago Pago")),
    ("Andorra", "Andorra", Some("Andorra la Vella")),
    ("Angola", "Angola", Some("Luanda")),
    ("Anguilla", "Anguilla", Some("The Valley")),
    ("Antarctica", "Antarctica", None),
    (
        "Antigua_and_Barb",
        "Antigua and Barbuda",
        Some("Saint John's"),
    ),
    ("Argentina", "Argentina", Some("Buenos Aires")),
    ("Armenia", "Armenia", Some("Yerevan")),
    ("Aruba", "Aruba", Some("Oranjestad")),
    (
        "Ashmore_and_Cartier_Is",
        "Ashmore and Cartier Islands",
        None,
    ),
    ("Australia", "Australia", Some("Canberra")),
    ("Austria", "Austria", Some("Vienna")),
    ("Azerbaijan", "Azerbaijan", Some("Baku")),
    ("Bahamas", "Bahamas", Some("Nassau")),
    ("Bahrain", "Bahrain", Some("Manama")),
    ("Bangladesh", "Bangladesh", Some("Dhaka")),
    ("Barbados", "Barbados", Some("Bridgetown")),
    ("Belarus", "Belarus", Some("Minsk")),
    ("Belgium", "Belgium", Some("Brussels")),
    ("Belize", "Belize", Some("Belmopan")),
    ("Benin", "Benin", Some("Porto-Novo")),
    ("Bermuda", "Bermuda", Some("Hamilton")),
    ("Bhutan", "Bhutan", Some("Thimphu")),
    ("Bir_Tawil", "Bir Tawil", None),
    ("Bolivia", "Bolivia", Some("Sucre")),
    (
        "Bosnia_and_Herz",
        "Bosnia and Herzegovina",
        Some("Sarajevo"),
    ),
    ("Botswana", "Botswana", Some("Gaborone")),
    (
        "Br._Indian_Ocean_Ter",
        "British Indian Ocean Territory",
        Some("Diego Garcia"),
    ),
    ("Brazil", "Brazil", Some("Brasília")),
    ("Brazilian_Island", "Brazilian Island", None),
    (
        "British_Virgin_Is",
        "British Virgin Islands",
        Some("Road Town"),
    ),
    ("Brunei", "Brunei", Some("Bandar Seri Begawan")),
    ("Bulgaria", "Bulgaria", Some("Sofia")),
    ("Burkina_Faso", "Burkina Faso", Some("Ouagadougou")),
    ("Burundi", "Burundi", Some("Gitega")),
    ("Cabo_Verde", "Cabo Verde", Some("Praia")),
    ("Cambodia", "Cambodia", Some("Phnom Penh")),
    ("Cameroon", "Cameroon", Some("Yaoundé")),
    ("Canada", "Canada", Some("Ottawa")),
    ("Cayman_Is", "Cayman Islands", Some("George Town")),
    (
        "Central_African_Rep",
        "Central African Republic",
        Some("Bangui"),
    ),
    ("Chad", "Chad", Some("N'Djamena")),
    ("Chile", "Chile", Some("Santiago")),
    ("China", "China", Some("Beijing")),
    ("Clipperton_I", "Clipperton Island", None),
    ("Colombia", "Colombia", Some("Bogotá")),
    ("Comoros", "Comoros", Some("Moroni")),
    ("Cook_Is", "Cook Islands", Some("Avarua")),
    ("Coral_Sea_Is", "Coral Sea Islands", None),
    ("Costa_Rica", "Costa Rica", Some("San José")),
    ("Croatia", "Croatia", Some("Zagreb")),
    ("Cuba", "Cuba", Some("Havana")),
    ("Curaçao", "Curaçao", Some("Willemstad")),
    ("Cyprus", "Cyprus", Some("Nicosia")),
    ("Czechia", "Czechia", Some("Prague")),
    ("Côte_d'Ivoire", "Côte d'Ivoire", Some("Yamoussoukro")),
    ("Dem._Rep._Korea", "North Korea", Some("Pyongyang")),
    (
        "Democratic_Republic_of_the_Congo",
        "Democratic Republic of the Congo",
        Some("Kinshasa"),
    ),
    ("Denmark", "Denmark", Some("Copenhagen")),
    ("Dhekelia", "Dhekelia", Some("Episkopi Cantonment")),
    ("Djibouti", "Djibouti", Some("Djibouti")),
    ("Dominica", "Dominica", Some("Roseau")),
    ("Dominican_Rep", "Dominican Republic", Some("Santo Domingo")),
    ("Ecuador", "Ecuador", Some("Quito")),
    ("Egypt", "Egypt", Some("Cairo")),
    ("El_Salvador", "El Salvador", Some("San Salvador")),
    ("Eq._Guinea", "Equatorial Guinea", Some("Malabo")),
    ("Eritrea", "Eritrea", Some("Asmara")),
    ("Estonia", "Estonia", Some("Tallinn")),
    ("Ethiopia", "Ethiopia", Some("Addis Ababa")),
    ("Faeroe_Islands", "Faroe Islands", Some("Tórshavn")),
    ("Falkland_Is", "Falkland Islands", Some("Stanley")),
    ("Fiji", "Fiji", Some("Suva")),
    ("Finland", "Finland", Some("Helsinki")),
    ("Fr._Polynesia", "French Polynesia", Some("Papeete")),
    (
        "Fr._S._and_Antarctic_Lands",
        "French Southern and Antarctic Lands",
        Some("Port-aux-Français"),
    ),
    ("France", "France", Some("Paris")),
    ("Gabon", "Gabon", Some("Libreville")),
    ("Gambia", "Gambia", Some("Banjul")),
    ("Georgia", "Georgia", Some("Tbilisi")),
    ("Germany", "Germany", Some("Berlin")),
    ("Ghana", "Ghana", Some("Accra")),
    ("Gibraltar", "Gibraltar", Some("Gibraltar")),
    ("Greece", "Greece", Some("Athens")),
    ("Greenland", "Greenland", Some("Nuuk")),
    ("Grenada", "Grenada", Some("St. George's")),
    ("Guam", "Guam", Some("Hagåtña")),
    ("Guantanamo_Bay_USNB", "Guantanamo Bay Naval Base", None),
    ("Guatemala", "Guatemala", Some("Guatemala City")),
    ("Guernsey", "Guernsey", Some("Saint Peter Port")),
    ("Guinea-Bissau", "Guinea-Bissau", Some("Bissau")),
    ("Guinea", "Guinea", Some("Conakry")),
    ("Guyana", "Guyana", Some("Georgetown")),
    ("Haiti", "Haiti", Some("Port-au-Prince")),
    (
        "Heard_I._and_McDonald_Is",
        "Heard Island and McDonald Islands",
        None,
    ),
    ("Honduras", "Honduras", Some("Tegucigalpa")),
    ("Hong_Kong", "Hong Kong", None),
    ("Hungary", "Hungary", Some("Budapest")),
    ("Iceland", "Iceland", Some("Reykjavík")),
    ("India", "India", Some("New Delhi")),
    ("Indian_Ocean_Ter", "Indian Ocean Territories", None),
    ("Indonesia", "Indonesia", Some("Jakarta")),
    ("Iran", "Iran", Some("Tehran")),
    ("Iraq", "Iraq", Some("Baghdad")),
    ("Ireland", "Ireland", Some("Dublin")),
    ("Isle_of_Man", "Isle of Man", Some("Douglas")),
    ("Italy", "Italy", Some("Rome")),
    ("Jamaica", "Jamaica", Some("Kingston")),
    ("Japan", "Japan", Some("Tokyo")),
    ("Jersey", "Jersey", Some("Saint Helier")),
    ("Jordan", "Jordan", Some("Amman")),
    ("Kazakhstan", "Kazakhstan", Some("Astana")),
    ("Kenya", "Kenya", Some("Nairobi")),
    ("Kiribati", "Kiribati", Some("Tarawa")),
    ("Kuwait", "Kuwait", Some("Kuwait City")),
    ("Kyrgyzstan", "Kyrgyzstan", Some("Bishkek")),
    ("Laos", "Laos", Some("Vientiane")),
    ("Latvia", "Latvia", Some("Riga")),
    ("Lebanon", "Lebanon", Some("Beirut")),
    ("Lesotho", "Lesotho", Some("Maseru")),
    ("Liberia", "Liberia", Some("Monrovia")),
    ("Libya", "Libya", Some("Tripoli")),
    ("Liechtenstein", "Liechtenstein", Some("Vaduz")),
    ("Lithuania", "Lithuania", Some("Vilnius")),
    ("Luxembourg", "Luxembourg", Some("Luxembourg")),
    ("Macao", "Macao", None),
    ("Madagascar", "Madagascar", Some("Antananarivo")),
    ("Malawi", "Malawi", Some("Lilongwe")),
    ("Malaysia", "Malaysia", Some("Kuala Lumpur")),
    ("Maldives", "Maldives", Some("Malé")),
    ("Mali", "Mali", Some("Bamako")),
    ("Malta", "Malta", Some("Valletta")),
    ("Marshall_Is", "Marshall Islands", Some("Majuro")),
    ("Mauritania", "Mauritania", Some("Nouakchott")),
    ("Mauritius", "Mauritius", Some("Port Louis")),
    ("Mexico", "Mexico", Some("Mexico City")),
    ("Micronesia", "Micronesia", Some("Palikir")),
    ("Moldova", "Moldova", Some("Chișinău")),
    ("Monaco", "Monaco", Some("Monaco")),
    ("Mongolia", "Mongolia", Some("Ulaanbaatar")),
    ("Montenegro", "Montenegro", Some("Podgorica")),
    ("Montserrat", "Montserrat", Some("Brades")),
    ("Morocco", "Morocco", Some("Rabat")),
    ("Mozambique", "Mozambique", Some("Maputo")),
    ("Myanmar", "Myanmar", Some("Naypyidaw")),
    ("N._Mariana_Is", "Northern Mariana Islands", Some("Saipan")),
    ("Namibia", "Namibia", Some("Windhoek")),
    ("Nauru", "Nauru", Some("Yaren")),
    ("Nepal", "Nepal", Some("Kathmandu")),
    ("Netherlands", "Netherlands", Some("Amsterdam")),
    ("New_Caledonia", "New Caledonia", Some("Nouméa")),
    ("New_Zealand", "New Zealand", Some("Wellington")),
    ("Nicaragua", "Nicaragua", Some("Managua")),
    ("Niger", "Niger", Some("Niamey")),
    ("Nigeria", "Nigeria", Some("Abuja")),
    ("Niue", "Niue", Some("Alofi")),
    ("Norfolk_Island", "Norfolk Island", Some("Kingston")),
    ("North_Macedonia", "North Macedonia", Some("Skopje")),
    ("Norway", "Norway", Some("Oslo")),
    ("Oman", "Oman", Some("Muscat")),
    ("Pakistan", "Pakistan", Some("Islamabad")),
    ("Palau", "Palau", Some("Ngerulmud")),
    ("Palestine", "Palestine", Some("Ramallah")),
    ("Panama", "Panama", Some("Panama City")),
    ("Papua_New_Guinea", "Papua New Guinea", Some("Port Moresby")),
    ("Paraguay", "Paraguay", Some("Asunción")),
    ("Peru", "Peru", Some("Lima")),
    ("Philippines", "Philippines", Some("Manila")),
    ("Pitcairn_Is", "Pitcairn Islands", Some("Adamstown")),
    ("Poland", "Poland", Some("Warsaw")),
    ("Portugal", "Portugal", Some("Lisbon")),
    ("Puerto_Rico", "Puerto Rico", Some("San Juan")),
    ("Qatar", "Qatar", Some("Doha")),
    ("Republic_of_Korea", "South Korea", Some("Seoul")),
    (
        "Republic_of_the_Congo",
        "Republic of the Congo",
        Some("Brazzaville"),
    ),
    ("Romania", "Romania", Some("Bucharest")),
    ("Russia", "Russia", Some("Moscow")),
    ("Rwanda", "Rwanda", Some("Kigali")),
    (
        "S._Geo._and_the_Is",
        "South Georgia and the South Sandwich Islands",
        Some("King Edward Point"),
    ),
    ("S._Sudan", "South Sudan", Some("Juba")),
    ("Saint-Martin", "Saint Martin", Some("Marigot")),
    ("Saint_Helena", "Saint Helena", Some("Jamestown")),
    (
        "Saint_Kitts_and_Nevis",
        "Saint Kitts and Nevis",
        Some("Basseterre"),
    ),
    ("Saint_Lucia", "Saint Lucia", Some("Castries")),
    ("Samoa", "Samoa", Some("Apia")),
    ("San_Marino", "San Marino", Some("San Marino")),
    (
        "Sao_Tome_and_Principe",
        "São Tomé and Príncipe",
        Some("São Tomé"),
    ),
    ("Saudi_Arabia", "Saudi Arabia", Some("Riyadh")),
    ("Scarborough_Reef", "Scarborough Reef", None),
    ("Senegal", "Senegal", Some("Dakar")),
    ("Serbia", "Serbia", Some("Belgrade")),
    ("Seychelles", "Seychelles", Some("Victoria")),
    ("Sierra_Leone", "Sierra Leone", Some("Freetown")),
    ("Singapore", "Singapore", Some("Singapore")),
    ("Sint_Maarten", "Sint Maarten", Some("Philipsburg")),
    ("Slovakia", "Slovakia", Some("Bratislava")),
    ("Slovenia", "Slovenia", Some("Ljubljana")),
    ("Solomon_Is", "Solomon Islands", Some("Honiara")),
    ("Somalia", "Somalia", Some("Mogadishu")),
    ("South_Africa", "South Africa", Some("Pretoria")),
    ("Spain", "Spain", Some("Madrid")),
    ("Spratly_Is", "Spratly Islands", None),
    ("Sri_Lanka", "Sri Lanka", Some("Sri Jayawardenepura Kotte")),
    ("St-Barthélemy", "Saint Barthélemy", Some("Gustavia")),
    (
        "St._Pierre_and_Miquelon",
        "Saint Pierre and Miquelon",
        Some("Saint-Pierre"),
    ),
    (
        "St._Vin._and_Gren",
        "Saint Vincent and the Grenadines",
        Some("Kingstown"),
    ),
    ("Sudan", "Sudan", Some("Khartoum")),
    ("Suriname", "Suriname", Some("Paramaribo")),
    ("Sweden", "Sweden", Some("Stockholm")),
    ("Switzerland", "Switzerland", Some("Bern")),
    ("Syria", "Syria", Some("Damascus")),
    ("Taiwan", "Taiwan", Some("Taipei")),
    ("Tajikistan", "Tajikistan", Some("Dushanbe")),
    ("Tanzania", "Tanzania", Some("Dodoma")),
    ("Thailand", "Thailand", Some("Bangkok")),
    ("Timor-Leste", "Timor-Leste", Some("Dili")),
    ("Togo", "Togo", Some("Lomé")),
    ("Tonga", "Tonga", Some("Nuku'alofa")),
    (
        "Trinidad_and_Tobago",
        "Trinidad and Tobago",
        Some("Port of Spain"),
    ),
    ("Tunisia", "Tunisia", Some("Tunis")),
    ("Turkey", "Turkey", Some("Ankara")),
    ("Turkmenistan", "Turkmenistan", Some("Ashgabat")),
    (
        "Turks_and_Caicos_Is",
        "Turks and Caicos Islands",
        Some("Cockburn Town"),
    ),
    ("Tuvalu", "Tuvalu", Some("Funafuti")),
    (
        "U.S._Minor_Outlying_Is",
        "United States Minor Outlying Islands",
        None,
    ),
    (
        "U.S._Virgin_Is",
        "United States Virgin Islands",
        Some("Charlotte Amalie"),
    ),
    ("Uganda", "Uganda", Some("Kampala")),
    ("Ukraine", "Ukraine", Some("Kyiv")),
    (
        "United_Arab_Emirates",
        "United Arab Emirates",
        Some("Abu Dhabi"),
    ),
    ("United_Kingdom", "United Kingdom", Some("London")),
    ("United_States", "United States", Some("Washington, D.C.")),
    ("Uruguay", "Uruguay", Some("Montevideo")),
    ("Uzbekistan", "Uzbekistan", Some("Tashkent")),
    ("Vanuatu", "Vanuatu", Some("Port Vila")),
    ("Vatican", "Vatican City", Some("Vatican City")),
    ("Venezuela", "Venezuela", Some("Caracas")),
    ("Vietnam", "Vietnam", Some("Hanoi")),
    ("W._Sahara", "Western Sahara", Some("Laayoune")),
    (
        "Wallis_and_Futuna_Islands",
        "Wallis and Futuna",
        Some("Mata-Utu"),
    ),
    ("Yemen", "Yemen", Some("Sana'a")),
    ("Zambia", "Zambia", Some("Lusaka")),
    ("Zimbabwe", "Zimbabwe", Some("Harare")),
    ("eSwatini", "Eswatini", Some("Mbabane")),
    ("Åland", "Åland", Some("Mariehamn")),
];

/// A [`MANUAL_CITIES`] row: (stem, city, lat, lon, population, is-capital).
type ManualCity = (&'static str, &'static str, f64, f64, Option<i64>, bool);

/// Capitals of territories missing from Natural Earth populated places.
const MANUAL_CITIES: &[ManualCity] = &[
    (
        "Anguilla",
        "The Valley",
        18.2170,
        -63.0578,
        Some(1067),
        true,
    ),
    (
        "Pitcairn_Is",
        "Adamstown",
        -25.0660,
        -130.1015,
        Some(40),
        true,
    ),
    (
        "Jersey",
        "Saint Helier",
        49.1866,
        -2.1065,
        Some(35822),
        true,
    ),
    (
        "Guernsey",
        "Saint Peter Port",
        49.4555,
        -2.5368,
        Some(18958),
        true,
    ),
    ("Nauru", "Yaren", -0.5477, 166.9209, Some(747), true),
    (
        "Saint_Helena",
        "Jamestown",
        -15.9251,
        -5.7179,
        Some(714),
        true,
    ),
    (
        "Wallis_and_Futuna_Islands",
        "Mata-Utu",
        -13.2825,
        -176.1736,
        Some(1029),
        true,
    ),
    (
        "Saint-Martin",
        "Marigot",
        18.0731,
        -63.0822,
        Some(5700),
        true,
    ),
    (
        "Sint_Maarten",
        "Philipsburg",
        18.0255,
        -63.0450,
        Some(1894),
        true,
    ),
    (
        "St-Barthélemy",
        "Gustavia",
        17.8958,
        -62.8508,
        Some(2615),
        true,
    ),
    ("Montserrat", "Brades", 16.7928, -62.2106, Some(391), true),
    ("Norfolk_Island", "Kingston", -29.0569, 167.9617, None, true),
    (
        "St._Pierre_and_Miquelon",
        "Saint-Pierre",
        46.7778,
        -56.1778,
        Some(5394),
        true,
    ),
    (
        "British_Virgin_Is",
        "Road Town",
        18.4269,
        -64.6200,
        Some(9400),
        true,
    ),
    ("Macao", "Macao", 22.1987, 113.5439, None, false),
    (
        "Dhekelia",
        "Dhekelia Cantonment",
        34.9877,
        33.7461,
        None,
        true,
    ),
    (
        "Akrotiri",
        "Episkopi Cantonment",
        34.6720,
        32.8232,
        None,
        true,
    ),
    (
        "Fr._S._and_Antarctic_Lands",
        "Port-aux-Français",
        -49.3517,
        70.2192,
        Some(45),
        true,
    ),
    (
        "Br._Indian_Ocean_Ter",
        "Diego Garcia",
        -7.3195,
        72.4229,
        None,
        false,
    ),
    (
        "U.S._Minor_Outlying_Is",
        "Wake Island",
        19.2823,
        166.6470,
        None,
        false,
    ),
    (
        "Indian_Ocean_Ter",
        "Flying Fish Cove",
        -10.4217,
        105.6791,
        Some(1599),
        true,
    ),
    (
        "U.S._Virgin_Is",
        "Charlotte Amalie",
        18.3419,
        -64.9307,
        Some(14477),
        true,
    ),
    (
        "W._Sahara",
        "Laayoune",
        27.1536,
        -13.2033,
        Some(217732),
        true,
    ),
];

/// Famous cities worth including even though they aren't among a country's
/// three biggest, keyed by stem. Each is looked up in Natural Earth populated
/// places by normalized name (so coordinates and population come from the
/// dataset); a name with no match only logs a warning.
const NOTABLE_CITIES: &[(&str, &str)] = &[
    ("Argentina", "Ushuaia"),           // southernmost city in the world
    ("Australia", "Perth"),             // most isolated big city
    ("Austria", "Salzburg"),            // Mozart's birthplace
    ("Belgium", "Brugge"),              // medieval old town (Bruges)
    ("Brazil", "Manaus"),               // Amazon metropolis
    ("Brazil", "Salvador"),             // first colonial capital
    ("Cambodia", "Siem Reap"),          // gateway to Angkor Wat
    ("Canada", "Vancouver"),            // Pacific gateway
    ("Canada", "Québec"),               // walled colonial city
    ("Chile", "Valparaíso"),            // painted port city
    ("China", "Xian"),                  // Terracotta Army
    ("China", "Lhasa"),                 // Tibetan capital
    ("Colombia", "Cartagena"),          // Caribbean walled city
    ("Croatia", "Dubrovnik"),           // Adriatic old town
    ("Croatia", "Split"),               // Diocletian's palace
    ("Egypt", "Luxor"),                 // Valley of the Kings
    ("France", "Nice"),                 // Côte d'Azur
    ("France", "Bordeaux"),             // wine capital
    ("Germany", "Cologne"),             // cathedral city
    ("India", "Agra"),                  // Taj Mahal
    ("India", "Jaipur"),                // the Pink City
    ("India", "Varanasi"),              // holy city on the Ganges
    ("Indonesia", "Denpasar"),          // Bali
    ("Indonesia", "Yogyakarta"),        // Borobudur region
    ("Iran", "Isfahan"),                // "half the world" square
    ("Iran", "Shiraz"),                 // Persepolis region
    ("Italy", "Venice"),                // canals
    ("Italy", "Florence"),              // Renaissance capital
    ("Japan", "Kyoto"),                 // old imperial capital
    ("Japan", "Hiroshima"),             // peace memorial
    ("Mali", "Timbuktu"),               // Saharan trading city
    ("Mexico", "Cancún"),               // Yucatán resort
    ("Morocco", "Marrakesh"),           // medina and souks
    ("Morocco", "Fez"),                 // oldest university
    ("Myanmar", "Mandalay"),            // last royal capital
    ("Netherlands", "The Hague"),       // seat of government
    ("New_Zealand", "Queenstown"),      // adventure capital
    ("Norway", "Bergen"),               // fjord gateway
    ("Peru", "Cusco"),                  // Inca capital, Machu Picchu
    ("Poland", "Kraków"),               // old royal capital
    ("Saudi_Arabia", "Makkah"),         // Mecca, holiest city of Islam
    ("Saudi_Arabia", "Medina"),         // second holiest
    ("Spain", "Seville"),               // Andalusian capital
    ("Spain", "Granada"),               // the Alhambra
    ("Tanzania", "Zanzibar"),           // Stone Town
    ("Thailand", "Chiang Mai"),         // northern temples
    ("Thailand", "Phuket"),             // island resort
    ("Turkey", "Antalya"),              // Turquoise Coast
    ("Ukraine", "Odessa"),              // Black Sea port
    ("Ukraine", "Lviv"),                // Habsburg old town
    ("United_Kingdom", "Edinburgh"),    // Scottish capital
    ("United_Kingdom", "Cardiff"),      // Welsh capital
    ("United_Kingdom", "Belfast"),      // Northern Irish capital
    ("United_Kingdom", "Liverpool"),    // maritime/music city
    ("United_States", "San Francisco"), // Golden Gate
    ("United_States", "Las Vegas"),     // desert entertainment
    ("United_States", "Miami"),         // Latin American gateway
    ("United_States", "New Orleans"),   // jazz birthplace
    ("United_States", "Honolulu"),      // Hawaii
    ("Uzbekistan", "Samarkand"),        // Silk Road jewel
    ("Uzbekistan", "Bukhara"),          // Silk Road old town
    ("Zimbabwe", "Victoria Falls"),     // the falls
];

/// Populated-places rows that are a territory's capital under another name
/// (or the settlement containing it), keyed by stem: they get the capital
/// flag even though their name doesn't match the declared capital.
const CAPITAL_ALIASES: &[(&str, &str)] = &[
    ("Guam", "Agana"),                     // Hagåtña's former name
    ("N._Mariana_Is", "Capitol Hill"),     // seat of government on Saipan
    ("S._Geo._and_the_Is", "Grytviken"),   // adjacent to King Edward Point
    ("Turks_and_Caicos_Is", "Grand Turk"), // the island of Cockburn Town
];

/// Natural Earth's admin-0 file codes South Sudan "SDS" but its populated
/// places use "SSD"; every other `ADM0_A3` code lines up.
fn adm0_alias(code: &str) -> &str {
    match code {
        "SDS" => "SSD",
        other => other,
    }
}

fn repo_root() -> PathBuf {
    // tools/update-countries -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// Download and unpack a Natural Earth layer into `.cache/` (idempotent).
fn ensure_dataset(name: &str) -> PathBuf {
    let cache = Path::new(env!("CARGO_MANIFEST_DIR")).join(".cache");
    let shp = cache.join(format!("{name}.shp"));
    if shp.exists() {
        return shp;
    }
    std::fs::create_dir_all(&cache).unwrap();
    let zip = cache.join(format!("{name}.zip"));
    eprintln!("downloading {name}...");
    let status = Command::new("curl")
        .args(["-fsSL", "-o"])
        .arg(&zip)
        .arg(format!("{NE_BASE}/{name}.zip"))
        .status()
        .expect("curl not found");
    assert!(status.success(), "download failed for {name}");
    let status = Command::new("unzip")
        .arg("-oq")
        .arg(&zip)
        .arg("-d")
        .arg(&cache)
        .status()
        .expect("unzip not found");
    assert!(status.success(), "unzip failed for {name}");
    assert!(shp.exists(), "{name}.zip did not contain {name}.shp");
    shp
}

/// Mirror of the am-shapefile CLI's filename sanitizer, so stems here match
/// the names `--split NAME` would produce.
fn sanitize_stem(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_whitespace() || c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '_']);
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// ASCII slug of a display name: the SVG filename and public URL identifier.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = true; // suppress leading dashes
    for c in name.to_lowercase().chars() {
        let mapped = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'í' | 'ï' => 'i',
            'ñ' => 'n',
            'ó' | 'ô' | 'ö' => 'o',
            'ú' | 'ü' => 'u',
            'ș' => 's',
            'ț' => 't',
            c => c,
        };
        if mapped.is_ascii_alphanumeric() {
            out.push(mapped);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    assert!(!out.is_empty() && out.is_ascii(), "bad slug for {name:?}");
    out
}

/// City coordinates rounded to a hundredth of an SVG user unit.
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// A city name reduced for comparison: the slug with the dashes dropped, so
/// spelling like `Nuku'alofa` / `Nukualofa` compares equal.
fn norm(name: &str) -> String {
    slugify(name).replace('-', "")
}

/// The same fit `am_shapefile::svg` computes when rendering: project every
/// point, then translate/scale the bounding box to `WIDTH`.
struct Transform {
    offset: Point,
    scale: f64,
    height: f64,
}

impl Transform {
    fn fit(sf: &Shapefile) -> Transform {
        let mut min = Point::new(f64::INFINITY, f64::INFINITY);
        let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        for shape in &sf.shapes {
            for_each_point(shape, |p| {
                let q = PROJECTION.project(p);
                min.x = min.x.min(q.x);
                min.y = min.y.min(q.y);
                max.x = max.x.max(q.x);
                max.y = max.y.max(q.y);
            });
        }
        let span_x = (max.x - min.x).max(f64::EPSILON);
        let span_y = (max.y - min.y).max(f64::EPSILON);
        let scale = WIDTH / span_x;
        Transform {
            offset: min,
            scale,
            height: span_y * scale,
        }
    }

    fn place(&self, lonlat: Point) -> Point {
        let q = PROJECTION.project(lonlat);
        Point::new(
            (q.x - self.offset.x) * self.scale,
            (q.y - self.offset.y) * self.scale,
        )
    }

    fn contains(&self, p: Point) -> bool {
        p.x >= 0.0 && p.x <= WIDTH && p.y >= 0.0 && p.y <= self.height
    }

    /// Snap a point into the viewBox. Coastal settlements can fall just off
    /// Natural Earth's simplified coastline; anything further out than 2% of
    /// the viewBox is a wrong coordinate, not simplification error.
    fn clamp(&self, p: Point, what: &str) -> Point {
        let clamped = Point::new(p.x.clamp(0.0, WIDTH), p.y.clamp(0.0, self.height));
        let off = (p.x - clamped.x).abs().max((p.y - clamped.y).abs());
        assert!(
            off <= 0.02 * WIDTH.max(self.height),
            "{what} lands {off:.0} units outside the viewBox"
        );
        clamped
    }
}

struct City {
    name: String,
    lonlat: Point,
    population: Option<i64>,
    capital: bool,
}

/// One row destined for the `countries` table, with its `cities` rows.
struct CountryRow {
    slug: String,
    name: String,
    population: Option<i64>,
    iso2: Option<String>,
    gdp: Option<i64>,
    cities: Vec<CityRow>,
}

struct CityRow {
    name: String,
    x: f64,
    y: f64,
    population: Option<i64>,
    capital: bool,
}

fn field_idx(sf: &Shapefile, name: &str) -> usize {
    sf.field_names
        .iter()
        .position(|n| n == name)
        .unwrap_or_else(|| panic!("field {name} missing"))
}

fn as_i64(v: &DbfValue) -> Option<i64> {
    match v {
        DbfValue::Integer(i) if *i > 0 => Some(*i),
        DbfValue::Number(f) if *f > 0.0 => Some(*f as i64),
        _ => None,
    }
}

/// The database DSN, from the environment or `backend/.env`, mirroring the
/// backend's `DatabaseConnection::from_env`.
fn database_dsn(root: &Path) -> Option<String> {
    dotenvy::from_path(root.join("backend/.env")).ok();
    if let Ok(dsn) = std::env::var("DATABASE_DSN") {
        return Some(dsn);
    }
    let username = std::env::var("DATABASE_USERNAME").ok()?;
    let password = std::env::var("DATABASE_PASSWORD").ok()?;
    let host = std::env::var("DATABASE_HOST").ok()?;
    let name = std::env::var("DATABASE_NAME").ok()?;
    let port = std::env::var("DATABASE_PORT").unwrap_or_else(|_| "5432".to_string());
    Some(format!(
        "postgres://{username}:{password}@{host}:{port}/{name}"
    ))
}

fn main() {
    let root = repo_root();
    let admin0 = read_shapefile(&ensure_dataset(ADMIN0)).expect("read admin0");
    let places = read_shapefile(&ensure_dataset(PLACES)).expect("read places");

    // Populated places grouped by admin-0 A3 code.
    let p_name = field_idx(&places, "name");
    let p_a3 = field_idx(&places, "adm0_a3");
    let p_cap = field_idx(&places, "adm0cap");
    let p_pop = field_idx(&places, "pop_max");
    let mut cities_by_a3: HashMap<String, Vec<City>> = HashMap::new();
    for (i, shape) in places.shapes.iter().enumerate() {
        let Shape::Point(p) = shape else { continue };
        let r = &places.records[i];
        cities_by_a3
            .entry(r[p_a3].to_string())
            .or_default()
            .push(City {
                name: r[p_name].to_string(),
                lonlat: *p,
                population: as_i64(&r[p_pop]),
                capital: matches!(&r[p_cap], DbfValue::Integer(1))
                    || matches!(&r[p_cap], DbfValue::Number(n) if *n == 1.0),
            });
    }

    let c_a3 = field_idx(&admin0, "ADM0_A3");
    let c_pop = field_idx(&admin0, "POP_EST");
    let c_iso2 = field_idx(&admin0, "ISO_A2_EH");
    let c_gdp = field_idx(&admin0, "GDP_MD");
    let meta: HashMap<&str, (&str, Option<&str>)> = COUNTRIES
        .iter()
        .map(|(stem, name, capital)| (*stem, (*name, *capital)))
        .collect();
    let manual: HashMap<&str, Vec<&ManualCity>> =
        MANUAL_CITIES.iter().fold(HashMap::new(), |mut m, row| {
            m.entry(row.0).or_default().push(row);
            m
        });

    let svg_dir = root.join("backend/assets/countries");
    if svg_dir.exists() {
        std::fs::remove_dir_all(&svg_dir).unwrap();
    }
    std::fs::create_dir_all(&svg_dir).unwrap();

    let parts = admin0.split_by("NAME").expect("split by NAME");
    let mut seen_stems: Vec<&str> = Vec::new();
    let mut entries: Vec<CountryRow> = Vec::new();

    for (raw_name, part) in &parts {
        if EXCLUDE.contains(&raw_name.as_str()) {
            continue;
        }
        let stem = sanitize_stem(raw_name);
        let Some(&(display, capital)) = meta.get(stem.as_str()) else {
            panic!("no COUNTRIES row for admin-0 NAME {raw_name:?} (stem {stem})");
        };
        seen_stems.push(meta.keys().find(|k| **k == stem).unwrap());
        let slug = slugify(display);
        let population = as_i64(&part.records[0][c_pop]);
        // "-99" is Natural Earth's placeholder for "no code assigned" (a
        // handful of disputed or uninhabited territories).
        let iso2 = {
            let raw = part.records[0][c_iso2].to_string();
            let trimmed = raw.trim();
            (!trimmed.is_empty() && trimmed != "-99").then(|| trimmed.to_lowercase())
        };
        let gdp = as_i64(&part.records[0][c_gdp]);

        // Render the SVG exactly as `am-shapefile svg --projection mercator`.
        let opts = SvgOptions {
            projection: PROJECTION,
            width: WIDTH,
        };
        let file = std::fs::File::create(svg_dir.join(format!("{slug}.svg"))).unwrap();
        part.to_svg(std::io::BufWriter::new(file), &opts)
            .expect("write svg");

        // Top cities: the three biggest in this territory plus its capital,
        // all inside the rendered viewBox.
        let t = Transform::fit(part);
        let a3 = adm0_alias(&part.records[0][c_a3].to_string()).to_string();
        let mut cities: Vec<&City> = cities_by_a3
            .get(&a3)
            .map(|v| v.iter().collect())
            .unwrap_or_default();
        cities.retain(|c| t.contains(t.place(c.lonlat)));
        cities.sort_by(|a, b| {
            b.population
                .unwrap_or(0)
                .cmp(&a.population.unwrap_or(0))
                .then(a.name.cmp(&b.name))
        });
        // The dataset carries occasional duplicate rows for one settlement
        // (e.g. Niamey twice); keep the biggest of each name.
        let mut seen_names: Vec<&str> = Vec::new();
        cities.retain(|c| {
            let fresh = !seen_names.contains(&c.name.as_str());
            if fresh {
                seen_names.push(&c.name);
            }
            fresh
        });
        let mut picked: Vec<&City> = cities.iter().take(3).copied().collect();
        // Pull the capital in if the top 3 missed it. The dataset's adm0cap
        // flag is patchy (it misses e.g. Juba), so a city whose name matches
        // the declared capital — or is aliased to it — counts too.
        let is_capital = |c: &City| {
            c.capital
                || capital.is_some_and(|cap| norm(&c.name) == norm(cap))
                || CAPITAL_ALIASES.contains(&(stem.as_str(), c.name.as_str()))
        };
        if let Some(cap) = cities.iter().find(|c| is_capital(c)) {
            if !picked.iter().any(|c| std::ptr::eq(*c, *cap)) {
                picked.push(cap);
            }
        }
        // Famous cities the population cut misses (matched loosely, since
        // Natural Earth's spellings vary: Xian, Odessa, Esfahan...).
        for (_, notable) in NOTABLE_CITIES.iter().filter(|(s, _)| *s == stem) {
            match cities.iter().find(|c| norm(&c.name) == norm(notable)) {
                Some(city) if !picked.iter().any(|c| std::ptr::eq(*c, *city)) => {
                    picked.push(city);
                }
                Some(_) => {} // already among the top cities
                None => eprintln!("warning: notable city {notable} not found for {display}"),
            }
        }
        let manual_cities: Vec<City> = manual
            .get(stem.as_str())
            .map(|rows| {
                rows.iter()
                    .map(|(_, name, lat, lon, pop, capital)| City {
                        name: name.to_string(),
                        lonlat: Point::new(*lon, *lat),
                        population: *pop,
                        capital: *capital,
                    })
                    .collect()
            })
            .unwrap_or_default();
        for c in &manual_cities {
            t.clamp(
                t.place(c.lonlat),
                &format!("manual city {} ({stem})", c.name),
            );
            picked.push(c);
        }
        if picked.is_empty() && capital.is_some() {
            eprintln!("warning: {display} has a capital but no city data");
        }

        let cities = picked
            .iter()
            .map(|c| {
                let q = t.clamp(t.place(c.lonlat), &c.name);
                CityRow {
                    name: c.name.clone(),
                    x: round2(q.x),
                    y: round2(q.y),
                    population: c.population,
                    capital: is_capital(c),
                }
            })
            .collect();
        entries.push(CountryRow {
            slug,
            name: display.to_string(),
            population,
            iso2,
            gdp,
            cities,
        });
    }

    // Every metadata row must have matched an admin-0 feature.
    let unused: Vec<&str> = COUNTRIES
        .iter()
        .map(|(stem, ..)| *stem)
        .filter(|stem| !seen_stems.contains(stem))
        .collect();
    assert!(
        unused.is_empty(),
        "COUNTRIES rows without admin-0 feature: {unused:?}"
    );

    entries.sort_by(|a, b| a.slug.cmp(&b.slug));
    println!(
        "wrote {} svgs to {}",
        std::fs::read_dir(&svg_dir).unwrap().count(),
        svg_dir.display()
    );

    if std::env::args().any(|a| a == "--skip-db") {
        println!("--skip-db: database left untouched");
        return;
    }
    let dsn =
        database_dsn(&root).expect("no database configured: set DATABASE_DSN (or pass --skip-db)");
    smol::block_on(update_database(&dsn, &root, &entries)).expect("database update failed");
    println!(
        "replaced countries/cities tables ({} countries)",
        entries.len()
    );
}

/// Apply the backend migrations, then swap in the freshly generated rows —
/// one transaction, so readers never see a half-updated table.
async fn update_database(
    dsn: &str,
    root: &Path,
    entries: &[CountryRow],
) -> Result<(), sqlx::Error> {
    let mut conn = PgConnection::connect(dsn).await?;
    sqlx::migrate::Migrator::new(root.join("backend/migrations"))
        .await?
        .run(&mut conn)
        .await?;

    let mut tx = conn.begin().await?;
    // `cities` rows go with their country via ON DELETE CASCADE.
    sqlx::query("DELETE FROM countries")
        .execute(&mut *tx)
        .await?;
    for country in entries {
        sqlx::query(
            "INSERT INTO countries (slug, name, population, iso2, gdp) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&country.slug)
        .bind(&country.name)
        .bind(country.population)
        .bind(&country.iso2)
        .bind(country.gdp)
        .execute(&mut *tx)
        .await?;
        for city in &country.cities {
            sqlx::query(
                "INSERT INTO cities (country_slug, name, x, y, population, capital) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&country.slug)
            .bind(&city.name)
            .bind(city.x)
            .bind(city.y)
            .bind(city.population)
            .bind(city.capital)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    conn.close().await?;
    Ok(())
}
