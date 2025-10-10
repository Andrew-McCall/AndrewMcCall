import { float_alert } from "./float_alert";

let secret_counter = 10;

export default (app: HTMLElement) => {
  window.addEventListener("click", function onClick(ev){
    if (window.location.pathname !== "/"){
      return window.removeEventListener("click", onClick)
    }

    if (secret_counter < 6){
      if (secret_counter < 1){
          window.navigate("/secret")
          return window.removeEventListener("click", onClick)
      }      
      float_alert(ev.x, ev.y, `You are ${secret_counter} clicks away from becoming a nerd`)
    }
    secret_counter -= 1; 
  })

  app.innerHTML += `<div class="flex justify-center items-center min-h-screen ">
  <h1 class="px-1 italic text-7xl font-bold bg-gradient-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
    Andrew David McCall
  </h1>
</div>`;
};
