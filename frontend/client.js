const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

let socket;
let mediaRecorder;
let deepgramKey; 

// STATE MANAGEMENT
let isAiSpeaking = false; // "Gate" to stop listening when AI talks
let audioQueue = [];      // Queue to prevent voices talking over each other
let isAudioPlaying = false;

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');
    
    // Toggle Logic
    if (btn.classList.contains("active")) {
        stopEverything();
        return;
    }

    // 1. Get Auth Token
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

    // 2. Open Microphone
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        return;
    }
    
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // 3. Connect to Deepgram
    // We added punctuate=true and endpointing=300 to make it snappier
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=300";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        'token', deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";
        
        mediaRecorder.addEventListener('dataavailable', event => {
            // CRITICAL FIX: Only send audio if the AI is NOT speaking.
            // This prevents the AI from hearing itself (Echo/Loop).
            if (event.data.size > 0 && socket.readyState === 1 && !isAiSpeaking) {
                socket.send(event.data);
            }
        });
        mediaRecorder.start(250);
    };

    socket.onmessage = async (message) => {
        const received = JSON.parse(message.data);
        const alternative = received.channel?.alternatives[0];
        
        if (alternative && received.is_final) {
            const transcript = alternative.transcript;
            const sentiment = alternative.sentiment;
            
            // Only proceed if there is actual text
            if (transcript && transcript.trim().length > 0) {
                document.getElementById('transcript').innerHTML = 
                    `You (${sentiment}): ${transcript}`;
                
                // 4. Send to Bedrock (Brain)
                document.getElementById('ai-response').innerText = "AI thinking...";
                
                // We fire this asynchronously so we don't block the UI
                handleAiProcessing(transcript, sentiment);
            }
        }
    };
    
    socket.onclose = () => {
        if (btn.classList.contains("active")) stopEverything();
    };
});

function stopEverything() {
    const btn = document.getElementById('micBtn');
    if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if(socket) socket.close();
    
    btn.innerText = "Start Demo";
    btn.classList.remove("active");
    document.getElementById('transcript').innerText = "Session ended.";
    isAiSpeaking = false;
    audioQueue = [];
}

async function handleAiProcessing(text, sentiment) {
    try {
        const brainRes = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ text, sentiment })
        });
        const brainData = await brainRes.json();
        const aiResponse = brainData.response;
        
        document.getElementById('ai-response').innerText = `AI: ${aiResponse}`;
        
        // 5. Queue the audio instead of playing immediately
        await queueAudio(aiResponse);
    } catch (e) {
        console.error("AI Error:", e);
    }
}

// --- AUDIO QUEUE SYSTEM ---

async function queueAudio(text) {
    // We fetch the audio blob immediately (prefetching) to reduce wait time
    const audioBlob = await fetchDeepgramAudio(text);
    if (!audioBlob) return;

    // Add to queue
    audioQueue.push(audioBlob);
    
    // If nothing is playing, start the player
    if (!isAudioPlaying) {
        playNextInQueue();
    }
}

async function playNextInQueue() {
    if (audioQueue.length === 0) {
        isAudioPlaying = false;
        isAiSpeaking = false; // Re-open the microphone
        return;
    }

    isAudioPlaying = true;
    isAiSpeaking = true; // Mute the microphone logic

    const blob = audioQueue.shift();
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    audio.onended = () => {
        // Recursively play the next one
        playNextInQueue();
    };

    audio.play();
}

async function fetchDeepgramAudio(text) {
    if (!deepgramKey) return null;
    const url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en";
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: text })
        });
        return await response.blob();
    } catch (e) {
        console.error("TTS Error:", e);
        return null;
    }
}