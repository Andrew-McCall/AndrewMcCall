import index from "./index.ts";
import secret_index from "./secret_index.ts";
import secret_morse from "./secret_morse.ts";
import secret_pi from "./secret_pi.ts";
import secret_canvas, { hideGame } from "./secret_canvas.ts";
import secret_password from "./secret_password.ts";
import secret_countries from "./secret_countries.ts";
import secret_visits, { disposeVisits } from "./secret_visits.ts";
import secret_login from "./secret_login.ts";
import secret_admin from "./secret_admin.ts";

window.addEventListener("popstate", () => {
  renderPage();
});

var app = document.querySelector<HTMLDivElement>("#app");
function renderPage(): void {
  if (!app) {
    return window.location.reload();
  }

  const page = window.location.pathname.toLowerCase();
  if (page !== "/secret/canvas") {
    hideGame(); // dismiss the fullscreen game overlay when navigating away
  }
  if (page !== "/secret/visits") {
    disposeVisits(); // tear down the ApexCharts when navigating away
  }

  app.innerHTML = "";

  if (page === "/") {
    return index(app);
  } 

  if (page === "/secret") {
    return secret_index(app);
  }

  if (page === "/secret/pi") {
    return secret_pi(app);
  }

  if (page === "/secret/morse"){
    return secret_morse(app)
  }

  if (page === "/secret/canvas"){
    return secret_canvas(app)
  }

  if (page === "/secret/password"){
    return secret_password(app)
  }

  if (page === "/secret/countries"){
    return secret_countries(app)
  }

  if (page === "/secret/visits"){
    return secret_visits(app)
  }

  if (page === "/secret/login"){
    return secret_login(app)
  }

  if (page === "/secret/admin"){
    secret_admin(app)
    return
  }

  // 404
  window.history.pushState({}, "", "/");
}


function navigateImpl(new_url: string): void {
  const url = String(new_url);
  window.history.pushState({}, '', url);
  renderPage();
}

declare global {
  interface Window {
    navigate: (new_url: string) => void;
  }
}

window.navigate = navigateImpl;
(globalThis as any).navigate = navigateImpl; 


renderPage();
