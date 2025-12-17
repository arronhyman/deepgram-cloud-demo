const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

let socket;
let mediaRecorder;
let deepgramKey; 

// STATE MANAGEMENT
let isAiSpeaking = false; // "Gate" to stop listening when AI talks

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

    // 3. Connect to Deepgram (STT)
    // punctuate=true helps us parse sentences better 
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=300";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        'token', deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";
        
        mediaRecorder.addEventListener('dataavailable', event => {
            // CRITICAL: Only send audio if the AI is NOT speaking.
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
                
                // Pause mic immediately so we don't interrupt the AI thinking
                isAiSpeaking = true; 
                
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
    
    // Reset flags
    isAiSpeaking = false;
}

// --- OPTIMIZED AI PROCESSING ---

async function handleAiProcessing(text, sentiment) {
    try {
        const brainRes = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ text, sentiment })
        });
        const brainData = await brainRes.json();
        const fullText = brainData.response;
        
        document.getElementById('ai-response').innerText = `AI: ${fullText}`;
        
        // 1. SPLIT TEXT INTO SENTENCES
        // This regex matches sentences ending in . ! or ?
        // It handles cases where the last sentence might not have punctuation.
        const sentences = fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [fullText];

        // 2. PARALLEL PRE-FETCHING (The Speed Fix)
        // We trigger all Deepgram requests IMMEDIATELY using .map()
        // We do NOT await them yet. This starts all downloads at t=0.
        const audioPromises = sentences.map(sentence => {
            const trimmed = sentence.trim();
            if (trimmed.length === 0) return null;
            return fetchDeepgramAudio(trimmed);
        });

        // 3. SEQUENTIAL PLAYBACK (The Cut-off Fix)
        // We loop through the promises in order.
        // Even though they are downloading in parallel, we play them one by one.
        for (const promise of audioPromises) {
            if (!promise) continue;
            
            // Wait for the specific sentence to finish downloading
            const blob = await promise; 
            
            if (blob) {
                // Wait for it to finish playing before starting the next loop iteration
                await playAudioBlob(blob); 
            }
        }
        
        // 4. ONLY NOW DO WE UNMUTE
        // We are 100% sure the entire loop is finished.
        if (document.getElementById('micBtn').classList.contains("active")) {
            isAiSpeaking = false;
            console.log("AI finished speaking. Mic open.");
        }
        
    } catch (e) {
        console.error("AI Error:", e);
        isAiSpeaking = false; // Release lock on error
    }
}

// --- HELPER FUNCTIONS ---

function playAudioBlob(blob) {
    return new Promise((resolve) => {
        // Double check user didn't hit stop in the middle
        const btn = document.getElementById('micBtn');
        if (!btn.classList.contains("active")) {
            resolve();
            return;
        }

        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        
        // Resolve the promise only when the audio ends
        audio.onended = () => {
            resolve(); 
        };
        
        // If audio fails to play, resolve anyway so the loop continues
        audio.play().catch(e => {
            console.error("Play Error:", e);
            resolve();
        });
    });
}

async function fetchDeepgramAudio(text) {
    if (!deepgramKey) return null;
    
    // OPTIMIZATION: encoding=linear16 (WAV) is much faster to decode than MP3
    // sample_rate=24000 is a good balance of quality and speed
    const url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000";
    
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