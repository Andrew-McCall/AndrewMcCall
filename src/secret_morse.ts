var press_start = 0
var click_length = 250
const MORSE_CODE: Record<string, string> = {
  ".-": "A",
  "-...": "B",
  "-.-.": "C",
  "-..": "D",
  ".": "E",
  "..-.": "F",
  "--.": "G",
  "....": "H",
  "..": "I",
  ".---": "J",
  "-.-": "K",
  ".-..": "L",
  "--": "M",
  "-.": "f",
  "---": "O",
  ".--.": "P",
  "--.-": "Q",
  ".-.": "R",
  "...": "S",
  "-": "T",
  "..-": "U",
  "...-": "V",
  ".--": "W",
  "-..-": "X",
  "-.--": "Y",
  "--..": "Z",

  "-----": "0",
  ".----": "1",
  "..---": "2",
  "...--": "3",
  "....-": "4",
  ".....": "5",
  "-....": "6",
  "--...": "7",
  "---..": "8",
  "----.": "9",

  ".-.-.-": ".",
  "--..--": ",",
  "..--..": "?",
  ".----.": "'",
  "-.-.--": "!",
  "-..-.": "/",
  "-.--.": "(",
  "-.--.-": ")",
  ".-...": "&",
  "---...": ":",
  "-.-.-.": ";",
  "-...-": "=",
  ".-.-.": "+",
  "-....-": "-",
  "..--.-": "_",
  ".-..-.": "\"",
  "...-..-": "$",
  ".--.-.": "@"
};


export default (app: HTMLElement) => {
  
  const container = document.createElement("div");
  container.className = "flex flex-col justify-center items-center m-auto h-screen text-lg text-green-500 pb-10";

  const translation = document.createElement("p");
  translation.className = "text-xl";
  translation.textContent = "Translation: ";
  container.appendChild(translation);

  const morse = document.createElement("p");
  morse.className = "text-2xl";
  morse.textContent = "\u00A0";
  container.appendChild(morse);

  window.addEventListener("keydown", (ev) => {
    if ((ev.timeStamp - press_start > click_length * 10) || ev.key !== " "){
      let potential = MORSE_CODE[morse.textContent.trimStart()]
      if (potential) {
        translation.textContent += potential
      }
      morse.textContent = "\u00A0"; 
    }
    press_start = ev.timeStamp
  })

  window.addEventListener("keyup", (ev) => {
    console.log(ev);
    if (ev.key !== " "){
      return
    }
    if (ev.timeStamp - press_start < click_length) {
      morse.textContent += "."
    }else{
      morse.textContent += "-"
    }
  })

  app.appendChild(container);

}