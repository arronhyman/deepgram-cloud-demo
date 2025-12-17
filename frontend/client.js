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

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
  }
  if (sttSocket) {
    sttSocket.close();
    sttSocket = null;
  }
}

/* ---------------------------
   STT (SPEECH TO TEXT)
---------------------------- */
function startSTT() {
    // 1. URL without token
    const sttUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&smart_format=true&endpointing=300';
    
    // 2. Pass token as subprotocol using the global deepgramKey
    // NOTE: removing 'const' so we write to the global sttSocket variable
    sttSocket = new WebSocket(sttUrl, ['token', deepgramKey]);

    sttSocket.onopen = () => {
        console.log('STT Connected');
        
        navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
            // NOTE: removing 'const' so we write to the global mediaRecorder variable
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            
            mediaRecorder.addEventListener('dataavailable', event => {
                if (event.data.size > 0 && sttSocket.readyState === 1) {
                    sttSocket.send(event.data);
                }
            });

            mediaRecorder.start(250); // Send chunks every 250ms
        });
    };

    sttSocket.onmessage = (message) => {
        const received = JSON.parse(message.data);
        const transcript = received.channel.alternatives[0].transcript;
        
        // Update UI with interim results
        if (transcript) {
          transcriptDiv.innerText = transcript;
        }

        // On Final result, send to AI
        if (transcript && received.is_final) {
            console.log("User said:", transcript);
            handleAIStreamingResponse(transcript);
        }
    };

    sttSocket.onerror = (error) => { console.error("STT Error:", error); };
    sttSocket.onclose = () => { console.log("STT Connection Closed"); };
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
    
    // Optional: Send a Flush command if Deepgram supports it, or just let it finish
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
    // 1. URL without token
    const ttsUrl = `wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=opus&container=webm`;

    // 2. Pass token as subprotocol
    const socket = new WebSocket(ttsUrl, ['token', deepgramKey]);
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
        // Only reject if it happens during connection phase
        if (socket.readyState !== WebSocket.OPEN) {
            reject(error);
        }
      };
      
      socket.onclose = () => {
        console.log("TTS Socket Closed");
      };
    });
  });
}