export default function watermark(){
	return; 	
	document.querySelector<HTMLDivElement>('#app')!.innerHTML += `
		<footer> V0 </footer>  
	`
}

