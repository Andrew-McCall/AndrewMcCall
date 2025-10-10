import index from "./index.ts";

window.addEventListener("popstate", () => {
  console.log("popstate");
  renderPage();
});

var app = document.querySelector<HTMLDivElement>("#app");
function renderPage() {
  console.log("renderPage");
  if (!app) {
    return window.location.reload();
  }

  app.innerHTML = "";
  const page = window.location.pathname.toLowerCase();

  if (page === "/") {
    index(app);
  } else {
    window.history.pushState({}, "", "/");
  }
}

renderPage();
