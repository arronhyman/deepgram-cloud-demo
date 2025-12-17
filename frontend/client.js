const micBtn = document.getElementById("micBtn");
const transcriptDiv = document.getElementById("transcript");
const aiResponseDiv = document.getElementById("ai-response");

const LAMBDA_URL =
  "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws";

let deepgramKey = null;
let sttSocket = null;
let mediaRecorder = null;

let ttsSocket = null;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;

let isActive = false;

/* ---------------------------
   INIT UI STATE
---------------------------- */
transcriptDiv.innerText = "";
aiResponseDiv.innerText = "";
micBtn.innerText = "Start Demo";

/* ---------------------------
   FETCH DEEPGRAM KEY
---------------------------- */
async function fetchDeepgramKey() {
  const res = await fetch(`${LAMBDA_URL}?route=auth`);
  const data = await res.json();
  deepgramKey = data.key;
}

/* ---------------------------
   START SESSION
---------------------------- */
async function startSession() {
  if (isActive) return;
  isActive = true;

  micBtn.innerText = "Stop";
  transcriptDiv.innerText = "Listening...";
  aiResponseDiv.innerText = "";

  if (!deepgramKey) {
    await fetchDeepgramKey();
  }

  startSTT();
}

/* ---------------------------
   STOP SESSION
---------------------------- */
function stopSession() {
  isActive = false;

  micBtn.innerText = "Start Demo";
  transcriptDiv.innerText = "Session ended.";

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (sttSocket) {
    sttSocket.close();
    sttSocket = null;
  }

  if (ttsSocket) {
    ttsSocket.close();
    ttsSocket = null;
  }

  audioQueue = [];
  isPlaying = false;
}

/* ---------------------------
   STT (MIC → TEXT)
---------------------------- */
async function startSTT() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  const sttUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?model=nova-2" +
    "&interim_results=true" +
    "&endpointing=300";

  sttSocket = new WebSocket(sttUrl, ["token", deepgramKey]);

  sttSocket.onopen = () => {
    mediaRecorder.start(250);
  };

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && sttSocket.readyState === 1) {
      sttSocket.send(event.data);
    }
  };

  sttSocket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    transcriptDiv.innerText = alt.transcript;

    if (!data.is_final) return;

    mediaRecorder.stop();
    sttSocket.close();

    await handleAIResponse(alt.transcript);
  };
}

/* ---------------------------
   AI CALL
---------------------------- */
async function handleAIResponse(text) {
  aiResponseDiv.innerText = "Thinking...";

  const res = await fetch(LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  const data = await res.json();
  aiResponseDiv.innerText = data.response;

  speakStreaming(data.response);
}

/* ---------------------------
   STREAMING TTS
---------------------------- */
function speakStreaming(text) {
  if (!isActive) return;

  if (!audioContext) {
    audioContext = new AudioContext();
  }

  audioQueue = [];
  isPlaying = false;

  const ttsUrl =
    "wss://api.deepgram.com/v1/speak" +
    "?model=aura-asteria-en" +
    "&encoding=linear16" +
    "&sample_rate=16000";

  ttsSocket = new WebSocket(ttsUrl, ["token", deepgramKey]);
  ttsSocket.binaryType = "arraybuffer";

  ttsSocket.onopen = () => {
    ttsSocket.send(JSON.stringify({ text }));
  };

  ttsSocket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      audioQueue.push(event.data);
      if (!isPlaying) playAudioQueue();
    }
  };

  ttsSocket.onclose = () => {
    // Restart listening after speech ends
    if (isActive) {
      transcriptDiv.innerText = "Listening...";
      startSTT();
    }
  };
}

/* ---------------------------
   AUDIO PIPELINE
---------------------------- */
async function playAudioQueue() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;

  const chunk = audioQueue.shift();
  const wav = pcm16ToWav(chunk);
  const buffer = await audioContext.decodeAudioData(wav);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();

  source.onended = playAudioQueue;
}

/* ---------------------------
   PCM → WAV
---------------------------- */
function pcm16ToWav(pcm) {
  const pcm16 = new Int16Array(pcm);
  const buffer = new ArrayBuffer(44 + pcm16.length * 2);
  const view = new DataView(buffer);

  const write = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));

  write(0, "RIFF");
  view.setUint32(4, 36 + pcm16.length * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm16.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return buffer;
}

/* ---------------------------
   BUTTON
---------------------------- */
micBtn.onclick = () => {
  isActive ? stopSession() : startSession();
};