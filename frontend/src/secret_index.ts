export default (app: HTMLElement) => {
  app.innerHTML += `
<div class="flex flex-col justify-center items-center py-2">
  <a href="/">
    <h1 title="Well Done" class="hover:underline italic text-7xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Secret Menu
    </h1>
  </a>
  <div class="flex justify-center space-y-2 mt-4 flex-col text-center text-lg">
    <a href="/secret/pi" class="text-lime-400 hover:underline hover:text-lime-700">PI Tester</a>
    <a href="/secret/morse" class="text-lime-400 hover:underline hover:text-lime-700">Morse Code</a>
    <a href="/secret/canvas" class="text-lime-400 hover:underline hover:text-lime-700">Rust Canvas</a>
    <a href="/secret/password" class="text-lime-400 hover:underline hover:text-lime-700">Password Generator</a>
    <a href="/secret/countries" class="text-lime-400 hover:underline hover:text-lime-700">Countries Quiz</a>
    <a href="/secret/visits" class="text-lime-400 hover:underline hover:text-lime-700">Visits</a>
    <a href="/secret/login" class="text-lime-400 hover:underline hover:text-lime-700">Sign in</a>
    <a href="/secret/soon" class="text-lime-400 italic line-through hover:cursor-pointer hover:text-lime-700" > coming soon </a>
  </div>
</div>
`;
};
