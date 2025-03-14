export default function watermark(){
	document.querySelector<HTMLDivElement>('#app')!.innerHTML += `
		<footer> V0 </footer>  
	`
}

