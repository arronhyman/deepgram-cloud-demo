const micBtn = document.getElementById("micBtn");
const transcriptDiv = document.getElementById("transcript");
const aiResponseDiv = document.getElementById("ai-response");

let deepgramKey = null;
let sttSocket = null;
let ttsSocket = null;

let audioContext = null;
let audioQueue = [];
let isPlaying = false;

const LAMBDA_URL =
  "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws";

/* ---------------------------
   FETCH DEEPGRAM API KEY
---------------------------- */
async function fetchDeepgramKey() {
  const res = await fetch(`${LAMBDA_URL}?route=auth`);
  const data = await res.json();
  deepgramKey = data.key;
}

/* ---------------------------
   START MICROPHONE + STT
---------------------------- */
async function startListening() {
  if (!deepgramKey) {
    await fetchDeepgramKey();
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm",
  });

  const sttUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?model=nova-2" +
    "&language=en-US" +
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

    // Only act on FINAL transcripts
    if (!data.is_final) return;

    mediaRecorder.stop();
    sttSocket.close();

    await handleAIResponse(alt.transcript);
  };
}

/* ---------------------------
   CALL LAMBDA (AI RESPONSE)
---------------------------- */
async function handleAIResponse(text) {
  aiResponseDiv.innerText = "Thinking...";

  const res = await fetch(LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "chat",
      text,
      session_id: "demo",
    }),
  });

  const data = await res.json();
  aiResponseDiv.innerText = data.response;

  speakStreaming(data.response);
}

/* ---------------------------
   STREAMING TTS (FIXES LAG)
---------------------------- */
function speakStreaming(text) {
  if (!deepgramKey || !text) return;

  // Kill previous speech immediately
  if (ttsSocket) {
    ttsSocket.close();
    ttsSocket = null;
  }

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

  ttsSocket.onmessage = async (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    audioQueue.push(event.data);
    if (!isPlaying) playAudioQueue();
  };

  ttsSocket.onclose = () => {
    ttsSocket = null;
  };

  ttsSocket.onerror = (e) => {
    console.error("TTS error", e);
  };
}

/* ---------------------------
   AUDIO PLAYBACK PIPELINE
---------------------------- */
async function playAudioQueue() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;

  const chunk = audioQueue.shift();
  const wavBuffer = pcm16ToWav(chunk);

  const audioBuffer = await audioContext.decodeAudioData(wavBuffer);
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();

  source.onended = () => {
    playAudioQueue();
  };
}

/* ---------------------------
   PCM → WAV CONVERTER
---------------------------- */
function pcm16ToWav(pcmData) {
  const pcm16 = new Int16Array(pcmData);
  const buffer = new ArrayBuffer(44 + pcm16.length * 2);
  const view = new DataView(buffer);

  function writeStr(o, s) {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(o + i, s.charCodeAt(i));
    }
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm16.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm16.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return buffer;
}

/* ---------------------------
   UI
---------------------------- */
micBtn.onclick = () => {
  transcriptDiv.innerText = "Listening...";
  aiResponseDiv.innerText = "";
  startListening();
};