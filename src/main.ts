import './styles.css'
import watermark from './version.ts'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
	<h1> WIP </h1>
  </div>
`

watermark();
