const micBtn = document.getElementById("micBtn");
const transcriptDiv = document.getElementById("transcript");
const aiResponseDiv = document.getElementById("ai-response");

// NOTE: Ensure your Lambda Function URL is configured for RESPONSE_STREAM invoke mode
const LAMBDA_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws";

let deepgramKey = null;
let sttSocket = null;
let mediaRecorder = null;
let isSessionActive = false;

/* ---------------------------
   INIT
---------------------------- */
micBtn.onclick = () => {
  isSessionActive ? stopSession() : startSession();
};

/* ---------------------------
   SESSION MANAGEMENT
---------------------------- */
async function startSession() {
  if (isSessionActive) return;
  isSessionActive = true;

  micBtn.innerText = "Stop";
  transcriptDiv.innerText = "Listening...";
  aiResponseDiv.innerText = "";

  try {
    if (!deepgramKey) {
      console.log("Fetching Deepgram Key...");
      const res = await fetch(`${LAMBDA_URL}?route=auth`);
      const data = await res.json();
      deepgramKey = data.key;
      console.log("Key received.");
    }
    startSTT();
  } catch (err) {
    console.error("Auth failed:", err);
    stopSession();
  }
}

function stopSession() {
  isSessionActive = false;
  micBtn.innerText = "Start Demo";
  transcriptDiv.innerText += " (Session ended)";

  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if (sttSocket) {
    sttSocket.close();
    sttSocket = null;
  }
}

/* ---------------------------
   STT (SPEECH TO TEXT)
---------------------------- */
async function startSTT() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  // STT uses the subprotocol method for auth (standard for Deepgram STT)
  const sttUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&smart_format=true&endpointing=300";
  sttSocket = new WebSocket(sttUrl, ["token", deepgramKey]);

  sttSocket.onopen = () => {
    if (mediaRecorder.state === "inactive") mediaRecorder.start(250);
  };

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && sttSocket.readyState === WebSocket.OPEN) {
      sttSocket.send(event.data);
    }
  };

  sttSocket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    transcriptDiv.innerText = alt.transcript;

    if (data.is_final) {
      // Stop listening immediately to process response
      mediaRecorder.stop();
      sttSocket.close();
      await handleAIStreamingResponse(alt.transcript);
    }
  };
}

/* ---------------------------
   PIPELINE: STREAMING LLM -> STREAMING TTS
---------------------------- */
async function handleAIStreamingResponse(userText) {
  aiResponseDiv.innerText = "Thinking...";

  // 1. Setup TTS Pipeline immediately (Connect to Deepgram)
  let ttsSocket;
  try {
    ttsSocket = await connectTTSSocket();
  } catch (e) {
    console.error("Failed to connect TTS:", e);
    return;
  }

  // 2. Call Python Backend (Stream Mode)
  try {
    const res = await fetch(LAMBDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let aiFullText = "";

    // 3. Read Chunks & Forward to TTS
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      aiFullText += chunk;
      aiResponseDiv.innerText = aiFullText; // Real-time UI update

      // Forward text chunk to Deepgram
      if (ttsSocket.readyState === WebSocket.OPEN) {
         // Sending small JSON chunks
        ttsSocket.send(JSON.stringify({ text: chunk }));
      }
    }
    
    // Close TTS input (Deepgram will finish speaking what's buffered)
    // Sending a specialized close frame or just closing connection
    // For Deepgram TTS, usually you just stop sending text.
    console.log("LLM stream finished.");

  } catch (err) {
    console.error("Streaming error:", err);
    aiResponseDiv.innerText = "Error getting response.";
  }
}

/* ---------------------------
   TTS SOCKET (Fixed for Browser)
---------------------------- */
function connectTTSSocket() {
  return new Promise((resolve, reject) => {
    // FIX: Pass token in URL query params, NOT in subprotocols
    const ttsUrl = `wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=opus&container=webm&token=${deepgramKey}`;

    const socket = new WebSocket(ttsUrl);
    socket.binaryType = "arraybuffer";

    // Setup Audio Context
    const mediaSource = new MediaSource();
    const audio = document.createElement("audio");
    audio.src = URL.createObjectURL(mediaSource);
    audio.autoplay = true;

    mediaSource.addEventListener("sourceopen", () => {
      const sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
      sourceBuffer.mode = 'sequence';

      const audioQueue = [];
      let isAppending = false;

      function processQueue() {
        if (!isAppending && audioQueue.length > 0 && !sourceBuffer.updating) {
          isAppending = true;
          try {
            sourceBuffer.appendBuffer(audioQueue.shift());
          } catch (e) {
            console.error("Buffer Error:", e);
            isAppending = false;
          }
        }
      }

      sourceBuffer.addEventListener("updateend", () => {
        isAppending = false;
        processQueue();
      });

      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          audioQueue.push(event.data);
          processQueue();
        }
      };

      socket.onopen = () => {
        console.log("TTS Socket Open");
        resolve(socket);
      };

      socket.onerror = (error) => {
        console.error("TTS WebSocket Error:", error);
        reject(error);
      };
      
      socket.onclose = () => {
        console.log("TTS Socket Closed");
      };
    });
  });
}