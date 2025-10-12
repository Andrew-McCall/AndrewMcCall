var length = 0
var click_length = 0.25

export default (app: HTMLElement) => {
  
  const morse = document.createElement("p");
  morse.className = "text-lg mb-4";
  morse.textContent = "";
  app.appendChild(morse);


  window.addEventListener("keydown", () => {
    length = Date.now()
  })

  window.addEventListener("keyup", () => {
    if (Date.now() - length < click_length) {
      morse.textContent += "."
    }else{
      morse.textContent += "_"
    }
  })

}