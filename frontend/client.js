// YOUR SPECIFIC LAMBDA URL
const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/";

let socket;              // Deepgram STT WebSocket
let mediaRecorder;
let deepgramKey;

let ttsSocket = null;     // Deepgram TTS Streaming WebSocket
let ttsAudioContext = null;
let isSpeaking = false;   // Prevents overlap

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');

    // Toggle Logic - Stop
    if (btn.classList.contains("active")) {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        if (socket) socket.close();
        if (ttsSocket) ttsSocket.close();

        btn.innerText = "Start Demo";
        btn.classList.remove("active");
        document.getElementById('transcript').innerText = "Session ended.";
        document.getElementById('ai-response').innerText = "";
        return;
    }

    // Start Demo
    btn.innerText = "Connecting...";
    try {
        const authRes = await fetch(API_URL + "?route=auth");
        const authData = await authRes.json();
        if (!authData.key) throw new Error(authData.error || "No Key Returned");
        deepgramKey = authData.key;
    } catch (e) {
        alert("Auth Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // Deepgram STT with endpointing for natural turn detection
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=700&interim_results=true";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, ['token', deepgramKey]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";

        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0 && socket.readyState === 1) {
                socket.send(event.data);
            }
        });
        mediaRecorder.start(250); // Send audio every 250ms
    };

    socket.onmessage = async (message) => {
        const received = JSON.parse(message.data);

        if (received.type === 'Metadata') return;

        const alternative = received.channel?.alternatives[0];

        // Show interim results (optional live transcription)
        if (received.is_final === false && alternative?.transcript) {
            document.getElementById('transcript').innerHTML = `You: ${alternative.transcript}...`;
        }

        // Only process when Deepgram detects end of utterance (solid final transcript)
        if (alternative && received.is_final && received.speech_final && alternative.transcript.trim()) {
            const transcript = alternative.transcript.trim();
            const sentiment = alternative.sentiment || 'neutral';

            document.getElementById('transcript').innerHTML = `You (${sentiment}): ${transcript}`;
            document.getElementById('ai-response').innerText = "AI thinking...";

            try {
                const brainRes = await fetch(API_URL, {
                    method: 'POST',
                    body: JSON.stringify({ text: transcript, sentiment: sentiment })
                });
                const brainData = await brainRes.json();
                const aiResponse = brainData.response;

                document.getElementById('ai-response').innerText = `AI: ${aiResponse}`;

                // Speak with low-latency streaming TTS
                await speakWithDeepgram(aiResponse);

            } catch (err) {
                console.error("Brain error:", err);
                document.getElementById('ai-response').innerText = "Error getting response.";
            }
        }
    };

    socket.onclose = () => {
        if (btn.classList.contains("active")) {
            btn.click(); // Clean up UI
        }
    };

    socket.onerror = (err) => {
        console.error("STT WebSocket error:", err);
        alert("Speech recognition error.");
        btn.click();
    };
});

// === Streaming TTS with Deepgram WebSocket (low latency + no overlap) ===
async function speakWithDeepgram(text) {
    if (!deepgramKey || isSpeaking) {
        console.log("Skipped speaking: already speaking or no key");
        return;
    }

    isSpeaking = true;
    document.getElementById('ai-response').innerText = `AI (speaking): ${text}`;

    // Close any previous TTS connection
    if (ttsSocket) ttsSocket.close();
    if (ttsAudioContext) ttsAudioContext.close();

    ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();

    ttsSocket = new WebSocket(
        `wss://api.deepgram.com/v1/speak?model=aura-asteria-en`, // or try aura-2-asteria-en if available
        ['token', deepgramKey]
    );

    ttsSocket.onopen = () => {
        ttsSocket.send(JSON.stringify({ type: 'Speak', text }));
        ttsSocket.send(JSON.stringify({ type: 'Flush' })); // Start generating immediately
    };

    ttsSocket.onmessage = async (event) => {
        if (event.data instanceof Blob) {
            try {
                const arrayBuffer = await event.data.arrayBuffer();
                const audioBuffer = await ttsAudioContext.decodeAudioData(arrayBuffer);

                const source = ttsAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ttsAudioContext.destination);
                source.start(0);
            } catch (e) {
                console.error("Audio decode error:", e);
            }
        }
    };

    ttsSocket.onclose = () => {
        isSpeaking = false;
        if (ttsAudioContext?.state !== 'closed') ttsAudioContext.close();
    };

    ttsSocket.onerror = (err) => {
        console.error("TTS WebSocket error:", err);
        isSpeaking = false;
    };
}