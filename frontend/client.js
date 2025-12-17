const micBtn = document.getElementById("micBtn");
const transcriptDiv = document.getElementById("transcript");
const aiResponseDiv = document.getElementById("ai-response");

const LAMBDA_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws";

let globalKey = null;
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
    // 1. Get Key if we don't have it
    if (!globalKey) {
      console.log("Fetching Deepgram Key...");
      const res = await fetch(`${LAMBDA_URL}?route=auth`);
      const data = await res.json();
      
      // SAFETY: Trim whitespace to prevent auth errors
      globalKey = data.key ? data.key.trim() : null;
      
      if (!globalKey) throw new Error("No key received from Lambda");
      console.log("Key received (Length: " + globalKey.length + ")");
    }

    // 2. Start STT with the clean key
    startSTT(globalKey);

  } catch (err) {
    console.error("Auth/Start failed:", err);
    transcriptDiv.innerText = "Error: " + err.message;
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
function startSTT(apiKey) {
    // 3. Construct URL safely with the key in the Query String
    const sttUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&token=${apiKey}`;

    console.log("Connecting to STT...");
    sttSocket = new WebSocket(sttUrl);

    sttSocket.onopen = () => {
        console.log('STT Connected');
        
        navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            
            mediaRecorder.addEventListener('dataavailable', event => {
                if (event.data.size > 0 && sttSocket.readyState === 1) {
                    sttSocket.send(event.data);
                }
            });

            mediaRecorder.start(250);
        });
    };

    sttSocket.onmessage = (message) => {
        const received = JSON.parse(message.data);
        const transcript = received.channel?.alternatives[0]?.transcript;
        
        if (transcript) {
           transcriptDiv.innerText = transcript;
        }

        if (transcript && received.is_final) {
            console.log("User said:", transcript);
            handleAIStreamingResponse(transcript, apiKey);
        }
    };

    sttSocket.onerror = (error) => { 
        console.error("STT Error details:", error);
    };
    
    sttSocket.onclose = (event) => {
        if (event.code === 1006) {
             console.error("STT Authentication Failed (1006). Check your API Key.");
        }
    };
}

/* ---------------------------
   PIPELINE: STREAMING LLM -> STREAMING TTS
---------------------------- */
async function handleAIStreamingResponse(userText, apiKey) {
  aiResponseDiv.innerText = "Thinking...";

  let ttsSocket;
  try {
    ttsSocket = await connectTTSSocket(apiKey);
  } catch (e) {
    console.error("Failed to connect TTS:", e);
    return;
  }

  try {
    const res = await fetch(LAMBDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let aiFullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      aiFullText += chunk;
      aiResponseDiv.innerText = aiFullText;

      if (ttsSocket.readyState === WebSocket.OPEN) {
        ttsSocket.send(JSON.stringify({ text: chunk }));
      }
    }
    
    // Send Flush to ensure last audio chunk is played
    if (ttsSocket.readyState === WebSocket.OPEN) {
        ttsSocket.send(JSON.stringify({ text: " " })); // Hack to flush buffers sometimes
    }

  } catch (err) {
    console.error("Streaming error:", err);
  }
}

/* ---------------------------
   TTS SOCKET
---------------------------- */
function connectTTSSocket(apiKey) {
  return new Promise((resolve, reject) => {
    // 4. Clean URL for TTS
    const ttsUrl = `wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=opus&container=webm&token=${apiKey}`;

    const socket = new WebSocket(ttsUrl);
    socket.binaryType = "arraybuffer";

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
        if (socket.readyState !== WebSocket.OPEN) reject(error);
      };
    });
  });
}