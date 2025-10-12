export default (app: HTMLElement) => {
app.innerHTML += `
<div class="flex flex-col justify-center items-center py-2">
  <a href="/">
    <h1 title="Well Done" class="hover:underline italic text-7xl font-bold bg-gradient-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Secret Menu
    </h1>
  </a>
  <div class="flex justify-center space-y-2 mt-4 flex-col text-center text-lg">
    <a href="/secret/pi" class="text-lime-400 hover:underline hover:text-lime-700">PI Tester</a>
    <a href="/secret/morse" class="text-lime-400 hover:underline hover:text-lime-700">Morse Code</a>
    <a class="text-lime-400 italic line-through hover:cursor-pointer hover:text-lime-700" > coming soon </a>
  </div>
</div>
`;
};
