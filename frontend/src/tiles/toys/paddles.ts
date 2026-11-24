import "./paddles.css";
import { $, clamp } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

type State = "idle" | "play" | "over";

const COURT_HEIGHT = 200;
const MIN_COURT_WIDTH = 220;
const PADDLE_HEIGHT = 36;
const BALL_HALF = 4;
const WIN_SCORE = 7;
const SERVE_SPEED = 175;
const MAX_SPEED = 430;

const ARIA_LABEL =
  "Paddles. Move the mouse or use the up and down arrow keys. First to seven.";

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="pad-hud"></span>
  </div>
  <div class="courtbox" id="pad" tabindex="0" role="application"
    aria-label="${ARIA_LABEL}">
    <div class="pad-court" id="pad-court">
      <div class="pad-net"></div>
      <div class="pad-p" id="pad-l"></div>
      <div class="pad-p" id="pad-r"></div>
      <div class="pad-ball" id="pad-ball"></div>
      <div class="pad-msg" id="pad-msg"></div>
    </div>
  </div>`;

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const stage = $("#pad", host.body);
  const court = $("#pad-court", host.body);
  const leftPaddle = $("#pad-l", host.body);
  const rightPaddle = $("#pad-r", host.body);
  const ballEl = $("#pad-ball", host.body);
  const net = $(".pad-net", court);
  const msg = $("#pad-msg", host.body);
  const hud = $("#pad-hud", host.body);

  const held = new Set<string>();
  let courtWidth = 320;
  let random: Rng = Math.random;
  let scale = 1;
  let leftY = 82;
  let rightY = 82;
  let ballX = 160;
  let ballY = 100;
  let speedX = 0;
  let speedY = 0;
  let you = 0;
  let computer = 0;
  let state: State = "idle";
  let wait = 0;
  let last = 0;
  let aim: number | null = null;
  let wobble = 0;

  function serve(direction: number): void {
    const angle = (random() - 0.5) * 0.9;
    ballX = courtWidth / 2;
    ballY = 100;
    speedX = direction * SERVE_SPEED * Math.cos(angle);
    speedY = SERVE_SPEED * Math.sin(angle);
    wobble = (random() - 0.5) * 22;
    wait = 0.6;
  }

  function serveEitherWay(): void {
    serve(random() < 0.5 ? -1 : 1);
  }

  function flash(paddle: HTMLElement): void {
    paddle.classList.remove("hit");
    void paddle.offsetWidth;
    paddle.classList.add("hit");
  }

  function draw(): void {
    leftPaddle.style.translate = `8px ${leftY}px`;
    rightPaddle.style.translate = `${courtWidth - 14}px ${rightY}px`;
    ballEl.style.translate = `${ballX - BALL_HALF}px ${ballY - BALL_HALF}px`;
  }

  function message(): string {
    if (state === "idle") return "Click to serve";
    if (state === "play") return "";
    return you > computer
      ? "You win. Click to go again"
      : "Computer wins. Click to go again";
  }

  function paint(): void {
    hud.textContent = `you ${you} · computer ${computer}`;
    msg.textContent = message();
  }

  function reset(seed: number): void {
    random = rng(seed);
    you = 0;
    computer = 0;
    leftY = 82;
    rightY = 82;
    state = "idle";
    serveEitherWay();
    draw();
    paint();
  }

  function bounce(direction: number, paddleY: number): void {
    const half = PADDLE_HEIGHT / 2;
    const offset = clamp((ballY - (paddleY + half)) / half, -1, 1);
    const speed = Math.min(Math.hypot(speedX, speedY) * 1.06, MAX_SPEED);
    speedX = direction * Math.cos(offset * 0.95) * speed;
    speedY = Math.sin(offset * 0.95) * speed;
    wobble = (random() - 0.5) * 30;
  }

  function movePaddles(dt: number): void {
    if (held.has("ArrowUp")) {
      leftY -= 250 * dt;
    } else if (held.has("ArrowDown")) {
      leftY += 250 * dt;
    } else if (aim !== null) {
      leftY += clamp(aim - PADDLE_HEIGHT / 2 - leftY, -420 * dt, 420 * dt);
    }
    leftY = clamp(leftY, 0, COURT_HEIGHT - PADDLE_HEIGHT);
    const reach = (125 + you * 9) * dt;
    const chase = clamp(ballY - PADDLE_HEIGHT / 2 + wobble - rightY, -reach, reach);
    rightY = clamp(rightY + chase, 0, COURT_HEIGHT - PADDLE_HEIGHT);
  }

  function meets(paddleY: number): boolean {
    return ballY + BALL_HALF >= paddleY && ballY - BALL_HALF <= paddleY + PADDLE_HEIGHT;
  }

  function moveBall(dt: number): void {
    ballX += speedX * dt;
    ballY += speedY * dt;
    if (ballY < BALL_HALF) {
      ballY = BALL_HALF;
      speedY = Math.abs(speedY);
    }
    if (ballY > COURT_HEIGHT - BALL_HALF) {
      ballY = COURT_HEIGHT - BALL_HALF;
      speedY = -Math.abs(speedY);
    }
    if (speedX < 0 && ballX <= 18 && ballX >= 6 && meets(leftY)) {
      ballX = 18;
      bounce(1, leftY);
      flash(leftPaddle);
    }
    const rightFace = courtWidth - 18;
    if (speedX > 0 && ballX >= rightFace && ballX <= courtWidth - 6 && meets(rightY)) {
      ballX = rightFace;
      bounce(-1, rightY);
      flash(rightPaddle);
    }
  }

  function scorePoint(): void {
    const missedByYou = ballX < 0;
    if (missedByYou) computer++;
    else you++;
    if (you === WIN_SCORE || computer === WIN_SCORE) state = "over";
    else serve(missedByYou ? 1 : -1);
    paint();
  }

  function tick(time: number): void {
    const dt = Math.min(0.033, (time - last) / 1000 || 0);
    last = time;
    if (state !== "play") return;
    movePaddles(dt);
    if (wait > 0) {
      wait -= dt;
      draw();
      return;
    }
    moveBall(dt);
    if (ballX < -12 || ballX > courtWidth + 12) scorePoint();
    draw();
  }

  function go(): void {
    if (state === "over") {
      you = 0;
      computer = 0;
      serveEitherWay();
    }
    if (state !== "play") {
      state = "play";
      paint();
    }
  }

  function resize(): void {
    const width = stage.clientWidth - 16;
    const height = stage.clientHeight - 16;
    if (width < 20 || height < 20) return;
    const before = courtWidth;
    scale = height / COURT_HEIGHT;
    if (width / scale < MIN_COURT_WIDTH) scale = width / MIN_COURT_WIDTH;
    courtWidth = Math.round(width / scale);
    ballX *= courtWidth / before;
    court.style.width = `${courtWidth}px`;
    msg.style.width = `${courtWidth}px`;
    net.style.transform = `translateX(${courtWidth / 2 - 1}px)`;
    const left = (stage.clientWidth - courtWidth * scale) / 2;
    const top = (stage.clientHeight - COURT_HEIGHT * scale) / 2;
    court.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
    draw();
  }

  stage.addEventListener("pointerdown", go);
  stage.addEventListener("pointermove", (event) => {
    aim = (event.clientY - court.getBoundingClientRect().top) / scale;
  });
  stage.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      host.win.focus();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key !== " ") held.add(event.key);
    go();
  });
  stage.addEventListener("keyup", (event) => held.delete(event.key));
  stage.addEventListener("blur", () => held.clear());

  new ResizeObserver(resize).observe(stage);
  host.onSeed(reset);
  host.frame(tick);
};

export default toy;
