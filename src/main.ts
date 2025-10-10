import watermark from './version.ts'

import index from 'components/index.ts'

window.addEventListener('popstate', () => {
    rednerPage()
});

var app = document.querySelector<HTMLDivElement>('#app') 
def renderPage(){
    if (!app) {
        return window.location.reload();
    }
   
    app.innerHTML = "";   
    const page = window.location.pathname.toLowerCase();

    if (page === "/"){
        app.innerHTML = index();
    }else{
        window.history.pushState({}, '', '/');
    }
    
    watermark();
}

renderPage();


