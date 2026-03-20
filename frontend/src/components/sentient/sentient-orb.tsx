"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { cn } from "@/lib/utils";

type SentientOrbProps = {
  className?: string;
  mark?: string;
  status?: string;
  showLabel?: boolean;
  variant?: "hero" | "compact";
};

type Ember = {
  angle: number;
  distance: number;
  drift: number;
  speed: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
};

type RuntimeState = {
  width: number;
  height: number;
  radius: number;
  rotation: number;
  lastTime: number;
  embers: Ember[];
};

const TAU = Math.PI * 2;

const ORB_RENDER_PROFILE = {
  radiusScale: 0.314,
  maxEmbers: 22,
  initialEmbers: 22,
  spawnChance: 0.34,
} as const;

const ORB_SURFACE_PRESETS = {
  hero: {
    wrapperClassName:
      "w-[min(82vw,38svh,22rem)] sm:w-[min(68vw,40svh,24rem)] md:w-[min(46vw,42svh,26rem)]",
    markClassName: "text-[clamp(3.1rem,9.5vw,4.2rem)]",
    statusClassName: "mt-2 text-[9px] tracking-[0.42em]",
  },
  compact: {
    wrapperClassName: "w-[13rem] md:w-[14rem]",
    markClassName: "text-[2.5rem]",
    statusClassName: "mt-1.5 text-[8px] tracking-[0.36em]",
  },
} as const;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function createEmber(radius: number): Ember {
  const angle = rand(0, TAU);
  const life = rand(90, 200);
  const shade = Math.random();

  let r = 0;
  let g = 0;
  let b = 0;

  if (shade < 0.35) {
    r = Math.floor(rand(60, 130));
    g = Math.floor(rand(225, 255));
    b = Math.floor(rand(220, 255));
  } else if (shade < 0.68) {
    r = Math.floor(rand(20, 70));
    g = Math.floor(rand(195, 235));
    b = Math.floor(rand(205, 245));
  } else {
    r = Math.floor(rand(130, 200));
    g = Math.floor(rand(238, 255));
    b = Math.floor(rand(235, 255));
  }

  return {
    angle,
    distance: radius + rand(0, radius * 0.09),
    drift: rand(-0.009, 0.009),
    speed: rand(0.18, 0.75),
    life,
    maxLife: life,
    size: rand(0.7, 2.2),
    r,
    g,
    b,
  };
}

function drawOrb(
  context: CanvasRenderingContext2D,
  radius: number,
  rotation: number,
  time: number
) {
  const spread = radius * 2.7;

  const corona = context.createRadialGradient(
    0,
    0,
    radius * 0.5,
    0,
    0,
    radius * 1.72
  );
  corona.addColorStop(0, "rgba(30,185,170,0)");
  corona.addColorStop(0.38, "rgba(30,185,170,0.13)");
  corona.addColorStop(0.62, "rgba(20,150,138,0.07)");
  corona.addColorStop(1, "rgba(10,80,90,0)");
  context.beginPath();
  context.arc(0, 0, radius * 1.72, 0, TAU);
  context.fillStyle = corona;
  context.fill();

  context.save();
  context.beginPath();
  context.arc(0, 0, radius, 0, TAU);
  context.clip();

  const base = context.createRadialGradient(
    -radius * 0.09,
    -radius * 0.09,
    radius * 0.06,
    0,
    0,
    radius
  );
  base.addColorStop(0, "#60ead8");
  base.addColorStop(0.2, "#2ecfc0");
  base.addColorStop(0.45, "#18a898");
  base.addColorStop(0.7, "#0c7070");
  base.addColorStop(0.88, "#063e44");
  base.addColorStop(1, "#021e28");
  context.fillStyle = base;
  context.fillRect(-spread, -spread, spread * 2, spread * 2);

  for (let index = 0; index < 5; index += 1) {
    const fraction = index / 5;
    const bandAngle = rotation + fraction * TAU;
    const bandX = Math.cos(bandAngle) * radius * 0.6;
    const bandY = Math.sin(bandAngle) * radius * 0.2;
    const alpha = 0.03 + 0.018 * Math.sin(fraction * 2.1 + time * 0.0005);
    const band = context.createRadialGradient(
      bandX,
      bandY,
      0,
      bandX,
      bandY,
      radius * 0.52
    );

    band.addColorStop(0, `rgba(150,245,238,${alpha})`);
    band.addColorStop(1, "rgba(150,245,238,0)");
    context.fillStyle = band;
    context.fillRect(-spread, -spread, spread * 2, spread * 2);
  }

  const edgeFade = context.createRadialGradient(0, 0, radius * 0.48, 0, 0, radius);
  edgeFade.addColorStop(0, "rgba(0,0,0,0)");
  edgeFade.addColorStop(0.6, "rgba(4,30,38,0.12)");
  edgeFade.addColorStop(0.85, "rgba(6,40,50,0.35)");
  edgeFade.addColorStop(1, "rgba(8,45,55,0.55)");
  context.fillStyle = edgeFade;
  context.fillRect(-spread, -spread, spread * 2, spread * 2);

  const specular = context.createRadialGradient(
    -radius * 0.3,
    -radius * 0.32,
    0,
    -radius * 0.18,
    -radius * 0.2,
    radius * 0.46
  );
  specular.addColorStop(0, "rgba(200,255,250,0.44)");
  specular.addColorStop(0.4, "rgba(160,245,240,0.12)");
  specular.addColorStop(1, "rgba(160,245,240,0)");
  context.fillStyle = specular;
  context.fillRect(-spread, -spread, spread * 2, spread * 2);

  context.restore();

  const halo = context.createRadialGradient(
    0,
    0,
    radius * 0.82,
    0,
    0,
    radius * 1.22
  );
  halo.addColorStop(0, "rgba(46,207,192,0.22)");
  halo.addColorStop(0.35, "rgba(46,207,192,0.1)");
  halo.addColorStop(0.7, "rgba(20,160,150,0.04)");
  halo.addColorStop(1, "rgba(10,100,110,0)");
  context.beginPath();
  context.arc(0, 0, radius * 1.22, 0, TAU);
  context.fillStyle = halo;
  context.fill();
}

function drawEmbers(
  context: CanvasRenderingContext2D,
  embers: Ember[],
  radius: number,
  spawnChance: number,
  maxEmbers: number,
  deltaRatio: number
) {
  if (embers.length < maxEmbers && Math.random() < spawnChance) {
    embers.push(createEmber(radius));
  }

  const distanceScale = radius / 88;

  for (let index = embers.length - 1; index >= 0; index -= 1) {
    const ember = embers[index];
    ember.angle += ember.drift * deltaRatio;
    ember.distance +=
      ember.speed *
      (0.32 + (1 - ember.life / ember.maxLife) * 0.6) *
      deltaRatio *
      distanceScale;
    ember.life -= deltaRatio;

    const progress = Math.max(0, ember.life / ember.maxLife);
    let alpha =
      progress > 0.88
        ? (1 - progress) / 0.12
        : progress < 0.18
          ? progress / 0.18
          : 1;
    alpha *= 0.75;

    const size = Math.max(0.01, ember.size * (0.45 + progress * 0.55));
    const x = Math.cos(ember.angle) * ember.distance;
    const y = Math.sin(ember.angle) * ember.distance;
    const glow = context.createRadialGradient(x, y, 0, x, y, size * 3.2);

    glow.addColorStop(0, `rgba(${ember.r},${ember.g},${ember.b},${alpha})`);
    glow.addColorStop(
      0.4,
      `rgba(${ember.r},${ember.g},${ember.b},${alpha * 0.28})`
    );
    glow.addColorStop(1, `rgba(${ember.r},${ember.g},${ember.b},0)`);

    context.beginPath();
    context.fillStyle = glow;
    context.arc(x, y, size * 3.2, 0, TAU);
    context.fill();

    if (ember.life <= 0) {
      embers.splice(index, 1);
    }
  }
}

export function SentientOrb({
  className,
  mark = "P",
  status = "Awake",
  showLabel = true,
  variant = "hero",
}: SentientOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameRef = useRef<number | null>(null);
  const runtimeRef = useRef<RuntimeState>({
    width: 0,
    height: 0,
    radius: 0,
    rotation: 0,
    lastTime: 0,
    embers: [],
  });

  const paintFrame = useEffectEvent((timestamp: number, reducedMotion: boolean) => {
    const context = contextRef.current;
    const runtime = runtimeRef.current;

    if (!context || runtime.width === 0 || runtime.height === 0) {
      return;
    }

    const delta = runtime.lastTime === 0 ? 16.67 : timestamp - runtime.lastTime;
    runtime.lastTime = timestamp;

    if (!reducedMotion) {
      runtime.rotation += (delta / 16.67) * 0.003;
    }

    context.clearRect(0, 0, runtime.width, runtime.height);
    context.save();
    context.translate(runtime.width / 2, runtime.height / 2);

    drawOrb(context, runtime.radius, runtime.rotation, timestamp);

    if (reducedMotion) {
      drawEmbers(context, runtime.embers, runtime.radius, 0, 0, 0);
    } else {
      drawEmbers(
        context,
        runtime.embers,
        runtime.radius,
        ORB_RENDER_PROFILE.spawnChance,
        ORB_RENDER_PROFILE.maxEmbers,
        delta / 16.67
      );
    }

    context.restore();
  });

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    contextRef.current = context;

    const runtime = runtimeRef.current;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    let reducedMotion = mediaQuery.matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      runtime.width = rect.width;
      runtime.height = rect.height;
      runtime.radius =
        Math.min(rect.width, rect.height) * ORB_RENDER_PROFILE.radiusScale;
      runtime.rotation = 0;
      runtime.lastTime = 0;
      runtime.embers = Array.from(
        { length: ORB_RENDER_PROFILE.initialEmbers },
        () => createEmber(runtime.radius)
      );

      paintFrame(performance.now(), reducedMotion);
    };

    const loop = (time: number) => {
      paintFrame(time, reducedMotion);

      if (!reducedMotion) {
        frameRef.current = window.requestAnimationFrame(loop);
      }
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      runtime.lastTime = 0;

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      if (reducedMotion) {
        paintFrame(performance.now(), true);
      } else {
        frameRef.current = window.requestAnimationFrame(loop);
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    mediaQuery.addEventListener("change", handleMotionChange);

    resize();

    if (!reducedMotion) {
      frameRef.current = window.requestAnimationFrame(loop);
    }

    return () => {
      resizeObserver.disconnect();
      mediaQuery.removeEventListener("change", handleMotionChange);

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [variant]);

  const surfacePreset = ORB_SURFACE_PRESETS[variant];

  return (
    <div
      className={cn("relative inline-flex flex-col items-center", className)}
      role="img"
      aria-label={`Prem, ${status}`}
    >
      <div
        className={cn(
          "sentient-orb-float relative aspect-square",
          surfacePreset.wrapperClassName
        )}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 size-full"
        />

        {showLabel ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="translate-y-[2%] text-center">
              <span
                className={cn(
                  "block font-light tracking-[0.08em] text-[#e1fffc]/90 [text-shadow:0_0_26px_rgba(195,255,247,0.18)]",
                  surfacePreset.markClassName
                )}
              >
                {mark}
              </span>
              <span
                className={cn(
                  "font-label block uppercase text-[#b4ebe6]/55",
                  surfacePreset.statusClassName
                )}
              >
                {status}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
