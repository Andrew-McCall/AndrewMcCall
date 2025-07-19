import './styles.css'
import watermark from './version.ts'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="flex justify-center items-center min-h-screen bg-stone-950">
  <h1 class="italic text-7xl font-bold bg-gradient-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
    Andrew David McCall
  </h1>
</div>

`

watermark();
