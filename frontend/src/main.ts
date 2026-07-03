import index from "./index.ts";
import secret_index from "./secret_index.ts";
import secret_morse from "./secret_morse.ts";
import secret_pi from "./secret_pi.ts";

window.addEventListener("popstate", () => {
  renderPage();
});

var app = document.querySelector<HTMLDivElement>("#app");
function renderPage(): void {
  if (!app) {
    return window.location.reload();
  }

  app.innerHTML = "";
  const page = window.location.pathname.toLowerCase();

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
