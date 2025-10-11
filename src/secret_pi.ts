export default (app: HTMLElement) => {
  const pi = "3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067982148086513282306647093844609550582231725359408128481117450284102701938521105559644622948954930381964428810975665933446128475648233786783165271201909145648566923460348610454326648213393607260249141273724587006606315588174881520920962829254091715364367892590360011330530548820466521384146951941511609433057270365759591953092186117381932611793105118548074462379962749567351885752724891227938183011949129833673362440656643086021394946395224737190702179860943702770539217176293176752384674818467669405132000568127145263560827785771342757789609173637178721468440901224953430146549585371050792279689258923542019956112129021960864034418159813629774771309960518707211349999998372978049951059731732816096318595024459455346908302642522308253344685035261931188171010003137838752886587533208381420617177669147303598253490428755468731159562863882353787593751957781857780532171226806613001927876611195909216420198938095257201065485"; 
  let index = 2;
  let score = 0;
  let highScore = 0;
  let hide_hint = false;

  const container = document.createElement("div");
  container.className = "flex flex-col justify-center items-center py-10 text-green-600 h-screen";

  const title = document.createElement("h1");
  title.className = "text-4xl font-bold mb-4";
  title.textContent = "Pi Tester";
  container.appendChild(title);

  const currentDigitDisplay = document.createElement("p");
  currentDigitDisplay.className = "text-2xl font-mono mb-4";
  currentDigitDisplay.textContent = pi[index];

  const toggle_hint = () => {
    hide_hint = !hide_hint;
    currentDigitDisplay.style.opacity = hide_hint ? "0" : "1";
  };

  currentDigitDisplay.onclick = toggle_hint;

  const instruction = document.createElement("p");
  instruction.className = "text-lg mb-4";
  instruction.textContent = "Next digit of Pi:";
  instruction.onclick = toggle_hint;
  container.appendChild(instruction);

  container.appendChild(currentDigitDisplay);

  const correct = document.createElement("p");
  correct.className = "text-lg mb-2";
  correct.textContent = "3.";
  container.appendChild(correct);

  const scoreDisplay = document.createElement("p");
  scoreDisplay.className = "text-lg mb-2";
  scoreDisplay.innerHTML = `Correct digits: <span>${score}</span>`;
  container.appendChild(scoreDisplay);

  const highScoreDisplay = document.createElement("p");
  highScoreDisplay.className = "text-lg mb-64";
  highScoreDisplay.textContent = `High score: ${highScore}`;
  container.appendChild(highScoreDisplay);

  const scoreSpan = scoreDisplay.querySelector("span") as HTMLElement;

const bottomSection = document.createElement("div");
bottomSection.className = "flex flex-col items-center mb-4 w-full bottom-10 absolute md:w-1/2 w-11/12"; 

const hintBtn = document.createElement("button");
hintBtn.textContent = "Toggle Hint";
hintBtn.className = "bg-yellow-500 text-black text-lg py-2 rounded mb-3 px-4 w-full cursor-pointer";
hintBtn.onclick = toggle_hint;
bottomSection.appendChild(hintBtn);

const keypad = document.createElement("div");
keypad.className = "grid grid-cols-3 gap-2 w-full";
for (let i = 1; i <= 9; i++) {
  const btn = document.createElement("button");
  btn.textContent = i.toString();
  btn.className = "bg-green-700 text-white text-xl py-3 rounded w-full h-full cursor-pointer";
  btn.onclick = () => handleInput(i.toString());
  keypad.appendChild(btn);
}

const zeroBtn = document.createElement("button");
zeroBtn.textContent = "0";
zeroBtn.className = "bg-green-700 text-white text-xl py-3 rounded col-span-3 w-full h-full cursor-pointer";
zeroBtn.onclick = () => handleInput("0");
keypad.appendChild(zeroBtn);

bottomSection.appendChild(keypad);

container.appendChild(bottomSection);
app.appendChild(container);

  app.appendChild(container);

  const handleInput = (key: string) => {
    if (key === pi[index]) {
      score++;
      index++;
      scoreSpan.textContent = score.toString();
      currentDigitDisplay.textContent = pi[index] ?? "";
      correct.textContent = pi.slice(0, index);

      if (score > highScore) {
        highScore = score;
        highScoreDisplay.textContent = `High score: ${highScore}`;
      }
    } else {
      alert(`Wrong! Expected ${pi[index]}`);
      reset()
    }
  };

  const reset = () => {
    index = 2;
    score = 0;
    scoreSpan.textContent = score.toString();
    currentDigitDisplay.textContent = pi[index];
    correct.textContent = "3.";
  }

  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") return reset();
    if (e.key === " ") return toggle_hint();
    if (e.key >= "0" && e.key <= "9") return handleInput(e.key);
  });
};
