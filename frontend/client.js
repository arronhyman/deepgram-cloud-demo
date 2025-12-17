const micBtn = document.getElementById("micBtn");
const transcriptDiv = document.getElementById("transcript");
const aiResponseDiv = document.getElementById("ai-response");

// NOTE: Ensure this matches your Lambda URL exactly
const LAMBDA_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws";

let deepgramKey = null;
let sttSocket = null;
let mediaRecorder = null;
let isSessionActive = false;

/* ---------------------------
   INIT
---------------------------- */
micBtn.onclick = () => {
  if (isSessionActive) {
    stopSession();
  } else {
    startSession();
  }
};

/* ---------------------------
   SESSION MANAGEMENT
---------------------------- */
async function startSession() {
  if (isSessionActive) return;
  
  micBtn.innerText = "Stop";
  transcriptDiv.innerText = "Listening...";
  aiResponseDiv.innerText = "";
  isSessionActive = true;

  try {
    // 1. Fetch Key if missing
    if (!deepgramKey) {
      console.log("Fetching Deepgram Key...");
      const res = await fetch(`${LAMBDA_URL}?route=auth`);
      const data = await res.json();
      
      if (!data.key) throw new Error("No key returned from Lambda");
      
      // CRITICAL: Trim whitespace/newlines which cause WebSocket 403 errors
      deepgramKey = data.key.trim();
      console.log("Key received.");
    }

    // 2. Start STT (Microphone)
    await startSTT();

  } catch (err) {
    console.error("Session Start Failed:", err);
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
    // Send a close frame if open
    if (sttSocket.readyState === WebSocket.OPEN) sttSocket.close();
    sttSocket = null;
  }
}

/* ---------------------------
   STT (SPEECH TO TEXT)
---------------------------- */
function startSTT() {
  return new Promise((resolve, reject) => {
    // DOCS: https://developers.deepgram.com/docs/models-languages-overview
    const sttUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&token=${deepgramKey}`;

    sttSocket = new WebSocket(sttUrl);

    sttSocket.onopen = () => {
      console.log('STT Socket Connected');
      
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        
        mediaRecorder.addEventListener('dataavailable', event => {
          if (event.data.size > 0 && sttSocket.readyState === WebSocket.OPEN) {
            sttSocket.send(event.data);
          }
        });

        mediaRecorder.start(250); // Slice audio into 250ms chunks
        resolve();
      }).catch(reject);
    };

    sttSocket.onmessage = (message) => {
      const received = JSON.parse(message.data);
      const transcript = received.channel?.alternatives[0]?.transcript;
      
      if (transcript) {
        transcriptDiv.innerText = transcript;
      }

      if (transcript && received.is_final) {
        console.log("Final Transcript:", transcript);
        handleAIStreamingResponse(transcript);
      }
    };

    sttSocket.onerror = (error) => {
      console.error("STT WebSocket Error:", error);
      // If we haven't resolved yet, reject the promise
      if (sttSocket.readyState !== WebSocket.OPEN) reject(error);
    };

    sttSocket.onclose = (event) => {
      console.log("STT Closed", event.code, event.reason);
    };
  });
}

/* ---------------------------
   PIPELINE: STREAMING LLM -> STREAMING TTS
---------------------------- */
async function handleAIStreamingResponse(userText) {
  aiResponseDiv.innerText = "Thinking...";

  // 1. Connect TTS immediately (Pre-warm connection)
  let ttsSocket;
  try {
    ttsSocket = await connectTTSSocket();
  } catch (e) {
    console.error("TTS Connection Failed:", e);
    aiResponseDiv.innerText = "Error connecting to Speakers.";
    return;
  }

  // 2. Call LLM (Lambda)
  try {
    const res = await fetch(LAMBDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let aiFullText = "";

    // 3. Stream Text -> TTS
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      aiFullText += chunk;
      aiResponseDiv.innerText = aiFullText;

      if (ttsSocket.readyState === WebSocket.OPEN) {
        // Deepgram TTS expects a JSON object with a 'text' field
        ttsSocket.send(JSON.stringify({ text: chunk }));
      }
    }
    
    // 4. Close/Flush TTS
    // Sending "Close" tells Deepgram we are done sending text
    // DOCS: https://developers.deepgram.com/docs/tts-streaming-control-messages
    if (ttsSocket.readyState === WebSocket.OPEN) {
      ttsSocket.send(JSON.stringify({ type: "Close" }));
    }
    console.log("LLM Stream Finished");

  } catch (err) {
    console.error("LLM Streaming Error:", err);
  }
}

/* ---------------------------
   TTS SOCKET (TEXT TO SPEECH)
---------------------------- */
function connectTTSSocket() {
  return new Promise((resolve, reject) => {
    // DOCS: https://developers.deepgram.com/docs/tts-media-output-settings
    // container=webm and encoding=opus are standard for MSE (MediaSource Extensions) in browsers
    const ttsUrl = `wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=opus&container=webm&token=${deepgramKey}`;

    const socket = new WebSocket(ttsUrl);
    socket.binaryType = "arraybuffer";

    // Setup Audio Playback
    const mediaSource = new MediaSource();
    const audio = document.createElement("audio");
    audio.src = URL.createObjectURL(mediaSource);
    audio.autoplay = true;

    mediaSource.addEventListener("sourceopen", () => {
      // Create a buffer for Opus audio
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
            console.error("SourceBuffer Error:", e);
            isAppending = false; // reset on error
          }
        }
      }

      sourceBuffer.addEventListener("updateend", () => {
        isAppending = false;
        processQueue();
      });

      socket.onmessage = (event) => {
        // Deepgram sends audio as binary
        if (event.data instanceof ArrayBuffer) {
          audioQueue.push(event.data);
          processQueue();
        } 
        // Deepgram sends metadata as JSON strings
        else if (typeof event.data === 'string') {
          console.log("TTS Metadata:", event.data);
        }
      };

      socket.onopen = () => {
        console.log("TTS Socket Open");
        resolve(socket);
      };

      socket.onerror = (error) => {
        // Only reject if we haven't successfully opened yet
        if (socket.readyState !== WebSocket.OPEN) {
          reject(error);
        }
        console.error("TTS Socket Error:", error);
      };

      socket.onclose = () => {
        console.log("TTS Socket Closed");
        // End of stream
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      };
    });
  });
}