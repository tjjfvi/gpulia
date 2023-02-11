/// <reference lib="dom"/>

import { Matrix, Vector } from "./matrix.ts";
import { debounce } from "https://deno.land/std@0.167.0/async/debounce.ts";
import lzstring from "https://esm.sh/lz-string@1.4.4";

if (!("gpu" in navigator)) {
  alert("WebGPU is not supported.");
  throw 0;
}

const gpu = navigator.gpu as GPU;
const adapter = await gpu.requestAdapter();
if (!adapter) {
  alert("Failed to get GPU adapter.");
  throw 0;
}
const device = await adapter.requestDevice();

const shaderModule = device.createShaderModule({
  code: await fetch("./gpulia.wgsl").then((r) => r.text()),
});

const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ],
});

const calcPipeline = device.createComputePipeline({
  layout: device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  }),
  compute: {
    module: shaderModule,
    entryPoint: "calc",
  },
});

const drawPipeline = device.createComputePipeline({
  layout: device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  }),
  compute: {
    module: shaderModule,
    entryPoint: "draw",
  },
});

type CalcParams = [number, number, ...Vector, ...Vector, ...Vector];
class WorkerGroup {
  configWrite = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
  });

  config = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  bufferSize = 0;

  calcOut!: GPUBuffer;
  drawOut!: GPUBuffer;
  readBuffer!: GPUBuffer;
  bindGroup!: GPUBindGroup;

  commands!: GPUCommandBuffer;

  init(resultSize: number) {
    if (this.bufferSize >= resultSize) return;
    resultSize = Math.ceil(resultSize / 1024) * 1024;
    this.bufferSize = resultSize;
    console.log(resultSize);

    this.calcOut?.destroy();
    this.drawOut?.destroy();

    this.calcOut = device.createBuffer({
      size: resultSize,
      usage: GPUBufferUsage.STORAGE,
    });

    this.drawOut = device.createBuffer({
      size: resultSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this.readBuffer = device.createBuffer({
      size: resultSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.config } },
        { binding: 1, resource: { buffer: this.calcOut } },
        { binding: 2, resource: { buffer: this.drawOut } },
      ],
    });
  }

  ctx;
  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  rendering = false;
  queuedRender?: CalcParams;
  render(...params: CalcParams): void;
  async render(...params: CalcParams) {
    if (this.rendering) {
      this.queuedRender = params;
      return;
    }
    this.rendering = true;
    const [width, height] = params;
    console.log(params);
    const imageSize = width * height * 4;
    this.init(imageSize);

    await this.configWrite.mapAsync(GPUMapMode.WRITE);
    const configBuffer = this.configWrite.getMappedRange();
    new Uint32Array(configBuffer).set([width, height]);
    new Float32Array(configBuffer, 16, 12).set(params.slice(2));
    console.log(new Uint32Array(configBuffer));
    console.log(new Float32Array(configBuffer));
    this.configWrite.unmap();

    const commandEncoder = device.createCommandEncoder();

    commandEncoder.copyBufferToBuffer(this.configWrite, 0, this.config, 0, this.config.size);

    const calcPass = commandEncoder.beginComputePass();
    calcPass.setPipeline(calcPipeline);
    calcPass.setBindGroup(0, this.bindGroup);
    calcPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    calcPass.end();

    const drawPass = commandEncoder.beginComputePass();
    drawPass.setPipeline(drawPipeline);
    drawPass.setBindGroup(0, this.bindGroup);
    drawPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    drawPass.end();

    commandEncoder.copyBufferToBuffer;
    commandEncoder.copyBufferToBuffer(this.drawOut, 0, this.readBuffer, 0, this.bufferSize);

    device.queue.submit([commandEncoder.finish()]);
    await this.readBuffer.mapAsync(GPUMapMode.READ);
    const output = this.readBuffer.getMappedRange();

    const img = new ImageData(new Uint8ClampedArray(output, 0, imageSize), width, height);
    this.ctx.putImageData(img, 0, 0);
    this.readBuffer.unmap();
    this.rendering = false;
    if (this.queuedRender) {
      params = this.queuedRender;
      this.queuedRender = undefined;
      this.render(...params);
    }
  }
}

const body = document.body;

body.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

const defaultTransform = Matrix.mul(
  Matrix.scale(.003125),
  Matrix.identity,
);

let transform = parseHash() ?? defaultTransform;

const setHash = debounce(_setHash, 100);

let width = 0;
let height = 0;
const ab = new WorkerGroup(
  document.getElementById("ab") as HTMLCanvasElement,
);
const cd = new WorkerGroup(
  document.getElementById("cd") as HTMLCanvasElement,
);

resize();
render();

window.addEventListener("resize", resize);

interface DragState {
  target: "ab" | "cd";
  lock: boolean;
  axis?: 0 | 1;
  rotate: boolean;
  reference: [number, number];
  base: Matrix;
}

let drag: DragState | undefined;

body.addEventListener("keydown", (e) => {
  if (e.key === "r") {
    drag = undefined;
    transform = defaultTransform;
    render();
  }
});

body.addEventListener("mousedown", (e) => {
  const rotate = e.button === 2;
  (e.target! as HTMLElement).classList.add("active");
  drag = {
    target: e.target === ab.canvas ? "ab" : "cd",
    lock: rotate || e.shiftKey,
    rotate,
    reference: [e.clientX, e.clientY],
    base: transform,
  };
});

body.addEventListener("mouseup", (e) => {
  if (!drag) return;
  (drag.target === "ab" ? ab : cd).canvas.classList.remove("active");
  drag = undefined;
});

body.addEventListener("mousemove", (e) => {
  if (!drag) return;
  let delta: [number, number] = [
    drag.reference[0] - e.clientX,
    drag.reference[1] - e.clientY,
  ];
  if (drag.lock) {
    if (drag.axis === undefined) {
      const a0 = Math.abs(delta[0]);
      const a1 = Math.abs(delta[1]);
      if (a0 > 20 || a1 > 20) {
        drag.axis = Math.abs(delta[0]) > Math.abs(delta[1]) ? 0 : 1;
      }
    }
    if (drag.axis !== undefined) {
      delta[1 - drag.axis] = 0;
    }
  }
  if (!drag.rotate) {
    transform = Matrix.mul(
      drag.base,
      Matrix.translate(
        drag.target === "ab" ? [...delta, 0, 0] : [0, 0, ...delta],
      ),
    );
  } else if (drag.axis !== undefined) {
    const angle = delta[drag.axis] / 100;
    transform = Matrix.mul(
      drag.base,
      drag.target === "ab"
        ? (drag.axis === 0 ? Matrix.rotateXZ(angle) : Matrix.rotateYW(angle))
        : (drag.axis === 0 ? Matrix.rotateZY(angle) : Matrix.rotateWX(angle)),
    );
  }
  render();
});

body.addEventListener("wheel", (e) => {
  drag = undefined;
  transform = Matrix.mul(
    transform,
    Matrix.scale(1.001 ** e.deltaY),
  );
  render();
});

function resize() {
  width = ab.canvas.width = cd.canvas.width = (window.innerWidth / 2) | 0;
  height = ab.canvas.height = cd.canvas.height = window.innerHeight;
  render();
}

function render() {
  const [a, b, c, d, x] = transform;
  ab.render(width, height, ...x, ...a, ...b);
  cd.render(width, height, ...x, ...c, ...d);
  setHash();
}

function parseHash(): Matrix | undefined {
  if (!location.hash) return undefined;
  const data = (
    lzstring.decompressFromEncodedURIComponent(
      location.hash.slice(1),
    )!
  ).split(",").map((x) => +x);
  return [
    data.slice(0, 4),
    data.slice(4, 8),
    data.slice(8, 12),
    data.slice(12, 16),
    data.slice(16),
  ] as Matrix;
}

function _setHash() {
  history.replaceState(
    {},
    "",
    "#" +
      lzstring.compressToEncodedURIComponent(
        transform.flat().join(","),
      ),
  );
}
