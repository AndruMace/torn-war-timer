import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const CHAIN_DURATION = 300 // 5 minutes in seconds
const POLL_INTERVAL = 5000 // Poll API every 5 seconds (API only updates ~every 30s anyway)
const NETWORK_LATENCY_OFFSET = 2 // Subtract 2 seconds to compensate for API delay

type TimerStatus = 'stopped' | 'running' | 'warning' | 'critical' | 'dropped' | 'no-chain'

interface ChainData {
  current: number
  timeout: number
  cooldown: number
}

interface ApiResponse {
  chain?: ChainData
  error?: {
    code: number
    error: string
  }
}

function App() {
  const [timeRemaining, setTimeRemaining] = useState(CHAIN_DURATION)
  const [isRunning, setIsRunning] = useState(false)
  const [alarmThreshold, setAlarmThreshold] = useState(() => {
    return parseInt(localStorage.getItem('tornChainAlarmTime') || '60')
  })
  const [volume, setVolume] = useState(() => {
    return parseInt(localStorage.getItem('tornChainVolume') || '80')
  })

  // API integration state
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem('tornApiKey') || ''
  })
  const [apiMode, setApiMode] = useState(() => {
    return localStorage.getItem('tornApiMode') === 'true'
  })
  const [apiError, setApiError] = useState<string | null>(null)
  const [chainCount, setChainCount] = useState<number | null>(null)
  const [apiTimeout, setApiTimeout] = useState<number | null>(null)
  const lastApiTimeoutRef = useRef<number | null>(null)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [showApiSettings, setShowApiSettings] = useState(false)

  const audioContextRef = useRef<AudioContext | null>(null)
  const alarmPlayingRef = useRef(false)
  const oscillatorRef = useRef<OscillatorNode | null>(null)
  const lastAlarmTimeRef = useRef<number | null>(null)
  const pollIntervalRef = useRef<number | null>(null)
  const fetchChainDataRef = useRef<() => Promise<void>>(null!)

  // Initialize audio context
  const initAudio = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume()
    }
  }, [])

  // Play alarm sound
  const playAlarm = useCallback(() => {
    if (alarmPlayingRef.current || volume === 0) return

    initAudio()
    const audioContext = audioContextRef.current
    if (!audioContext) return

    alarmPlayingRef.current = true

    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)

    oscillator.type = 'square'
    gainNode.gain.value = (volume / 100) * 0.3

    const now = audioContext.currentTime
    oscillator.frequency.setValueAtTime(880, now)

    // Alternating frequency pattern for urgency
    for (let i = 0; i < 20; i++) {
      oscillator.frequency.setValueAtTime(880, now + i * 0.2)
      oscillator.frequency.setValueAtTime(660, now + i * 0.2 + 0.1)
    }

    oscillator.start(now)
    oscillator.stop(now + 4)

    oscillatorRef.current = oscillator

    oscillator.onended = () => {
      alarmPlayingRef.current = false
    }
  }, [volume, initAudio])

  // Stop alarm
  const stopAlarm = useCallback(() => {
    if (oscillatorRef.current) {
      try {
        oscillatorRef.current.stop()
      } catch {
        // Already stopped
      }
      alarmPlayingRef.current = false
    }
  }, [])

  // Fetch chain data from Torn API
  const fetchChainData = useCallback(async () => {
    if (!apiKey) {
      setApiError('No API key set')
      return
    }

    try {
      const response = await fetch(
        `https://api.torn.com/faction/?selections=chain&key=${apiKey}`
      )
      const data: ApiResponse = await response.json()

      if (data.error) {
        setApiError(`API Error: ${data.error.error}`)
        return
      }

      if (data.chain) {
        setApiError(null)
        setLastFetch(new Date())
        setChainCount(data.chain.current)

        const rawTimeout = data.chain.timeout
        setApiTimeout(rawTimeout)

        // Apply latency compensation (subtract offset, but don't go below 0)
        const timeout = Math.max(0, rawTimeout - NETWORK_LATENCY_OFFSET)

        // Chain is active
        if (rawTimeout > 0) {
          // Only update timeRemaining if API value changed (API updates ~every 30s)
          // This allows local countdown to run smoothly between API updates
          if (lastApiTimeoutRef.current !== rawTimeout) {
            const prevTime = lastAlarmTimeRef.current
            const isFirstLoad = prevTime === null

            // Check if we crossed the alarm threshold with this update
            const crossedThreshold = !isFirstLoad && prevTime > alarmThreshold && timeout <= alarmThreshold
            const crossedCritical15 = !isFirstLoad && prevTime > 15 && timeout <= 15
            const crossedCritical10 = !isFirstLoad && prevTime > 10 && timeout <= 10
            const crossedCritical5 = !isFirstLoad && prevTime > 5 && timeout <= 5

            // On first load, alarm if already below threshold
            const belowThresholdOnLoad = isFirstLoad && timeout <= alarmThreshold

            if (crossedThreshold || crossedCritical15 || crossedCritical10 || crossedCritical5 || belowThresholdOnLoad) {
              playAlarm()
            }

            setTimeRemaining(timeout)
            lastApiTimeoutRef.current = rawTimeout
            lastAlarmTimeRef.current = timeout
          }
          setIsRunning(true)
        } else if (data.chain.cooldown > 0) {
          // Chain is on cooldown (was dropped or completed)
          setTimeRemaining(0)
          setIsRunning(false)
          lastAlarmTimeRef.current = null
        } else if (data.chain.current === 0) {
          // No active chain
          setTimeRemaining(CHAIN_DURATION)
          setIsRunning(false)
          lastAlarmTimeRef.current = null
        }
      }
    } catch (err) {
      setApiError(`Network error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [apiKey, alarmThreshold, playAlarm])

  // Keep the ref updated with latest fetch function
  useEffect(() => {
    fetchChainDataRef.current = fetchChainData
  }, [fetchChainData])

  // API polling effect - uses ref to avoid resetting interval on re-renders
  useEffect(() => {
    if (apiMode && apiKey) {
      // Initial fetch
      fetchChainDataRef.current()

      // Set up polling using ref so interval doesn't reset
      pollIntervalRef.current = window.setInterval(() => {
        fetchChainDataRef.current()
      }, POLL_INTERVAL)

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
        }
      }
    }
  }, [apiMode, apiKey])

  // Timer countdown effect (runs in both modes for smooth display)
  useEffect(() => {
    if (!isRunning) return

    const interval = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) {
          if (!apiMode) {
            setIsRunning(false)
          }
          playAlarm()
          lastAlarmTimeRef.current = 0
          return 0
        }

        const newTime = prev - 1

        // Play alarm at threshold and critical moments
        // Check if we're crossing a threshold (prev was above, newTime is at or below)
        const prevAlarmTime = lastAlarmTimeRef.current
        let shouldAlarm = false

        if (newTime <= alarmThreshold && (prevAlarmTime === null || prevAlarmTime > alarmThreshold)) {
          shouldAlarm = true
        }
        if (newTime <= 15 && (prevAlarmTime === null || prevAlarmTime > 15)) {
          shouldAlarm = true
        }
        if (newTime <= 10 && (prevAlarmTime === null || prevAlarmTime > 10)) {
          shouldAlarm = true
        }
        if (newTime <= 5 && (prevAlarmTime === null || prevAlarmTime > 5)) {
          shouldAlarm = true
        }

        if (shouldAlarm) {
          playAlarm()
          lastAlarmTimeRef.current = newTime
        }

        return newTime
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [apiMode, isRunning, alarmThreshold, playAlarm])

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('tornChainAlarmTime', alarmThreshold.toString())
  }, [alarmThreshold])

  useEffect(() => {
    localStorage.setItem('tornChainVolume', volume.toString())
  }, [volume])

  useEffect(() => {
    localStorage.setItem('tornApiKey', apiKey)
  }, [apiKey])

  useEffect(() => {
    localStorage.setItem('tornApiMode', apiMode.toString())
  }, [apiMode])

  // Keyboard shortcuts (only for manual mode)
  useEffect(() => {
    if (apiMode) return // Disable manual shortcuts in API mode

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        handleReset()
      } else if (e.code === 'KeyS') {
        handleStart()
      } else if (e.code === 'KeyX' || e.code === 'Escape') {
        handleStop()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const handleStart = () => {
    initAudio()
    if (!isRunning) {
      setIsRunning(true)
    }
  }

  const handleReset = () => {
    initAudio()
    stopAlarm()
    setTimeRemaining(CHAIN_DURATION)
    if (!isRunning) {
      setIsRunning(true)
    }
  }

  const handleStop = () => {
    setIsRunning(false)
    stopAlarm()
  }

  const handleTestAlarm = () => {
    initAudio()
    stopAlarm()
    setTimeout(() => playAlarm(), 100)
  }

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value)
    setApiError(null)
  }

  const handleToggleApiMode = () => {
    const newMode = !apiMode
    setApiMode(newMode)
    if (newMode) {
      initAudio() // Init audio for API mode alarms
      fetchChainData()
    } else {
      // Reset to manual mode defaults
      setTimeRemaining(CHAIN_DURATION)
      setIsRunning(false)
      setChainCount(null)
      setApiTimeout(null)
      lastAlarmTimeRef.current = null
      lastApiTimeoutRef.current = null
    }
  }

  // Format time as M:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Determine timer status
  const getStatus = (): TimerStatus => {
    if (apiMode && chainCount === 0 && !isRunning) return 'no-chain'
    if (!isRunning && timeRemaining === 0) return 'dropped'
    if (!isRunning) return 'stopped'
    if (timeRemaining <= 15) return 'critical'
    if (timeRemaining <= alarmThreshold) return 'warning'
    return 'running'
  }

  const status = getStatus()

  const getStatusText = (): string => {
    switch (status) {
      case 'no-chain': return 'No Active Chain'
      case 'dropped': return 'CHAIN DROPPED!'
      case 'stopped': return 'Timer Stopped'
      case 'critical': return 'ATTACK NOW!'
      case 'warning': return 'Attack Soon!'
      case 'running': return 'Chain Active'
    }
  }

  return (
    <div className="container">
      {volume === 0 && <div className="mute-indicator">MUTED</div>}

      <h1>Torn Chain Timer</h1>
      <p className="subtitle">
        {apiMode ? 'Auto-sync with Torn API' : 'Keep your chain alive!'}
      </p>

      <div className={`timer-display ${status}`}>
        {formatTime(timeRemaining)}
      </div>

      <div className={`status ${status}`}>
        {getStatusText()}
      </div>

      {apiMode && (
        <div className="sync-status">
          {chainCount !== null ? `Chain: ${chainCount} hits` : 'Waiting for sync...'}
          {apiTimeout !== null && ` • API: ${Math.floor(apiTimeout / 60)}:${(apiTimeout % 60).toString().padStart(2, '0')}`}
        </div>
      )}

      {apiError && (
        <div className="api-error">
          {apiError}
        </div>
      )}

      {!apiMode && (
        <div className="buttons">
          <button className="btn-start" onClick={handleStart}>
            Start
          </button>
          <button className="btn-reset" onClick={handleReset}>
            Reset (Hit!)
          </button>
          <button className="btn-stop" onClick={handleStop}>
            Stop
          </button>
        </div>
      )}

      <div className="settings">
        <div className="setting-row">
          <label>Mode:</label>
          <button
            className={`mode-toggle ${apiMode ? 'api-active' : ''}`}
            onClick={handleToggleApiMode}
          >
            {apiMode ? 'Auto (API)' : 'Manual'}
          </button>
        </div>

        {apiMode && (
          <div className="api-settings">
            <button
              className="api-settings-toggle"
              onClick={() => setShowApiSettings(!showApiSettings)}
            >
              {showApiSettings ? 'Hide API Settings' : 'API Settings'}
            </button>

            {showApiSettings && (
              <div className="api-key-input">
                <label>API Key:</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={handleApiKeyChange}
                  placeholder="Enter your Torn API key"
                />
                <p className="api-help">
                  Get your API key from Torn: Settings → API Keys
                </p>
              </div>
            )}
          </div>
        )}

        <div className="setting-row">
          <label>Alarm at:</label>
          <select
            value={alarmThreshold}
            onChange={(e) => setAlarmThreshold(parseInt(e.target.value))}
          >
            <option value="120">2:00 remaining</option>
            <option value="90">1:30 remaining</option>
            <option value="60">1:00 remaining</option>
            <option value="45">0:45 remaining</option>
            <option value="30">0:30 remaining</option>
            <option value="20">0:20 remaining</option>
            <option value="15">0:15 remaining</option>
          </select>
        </div>

        <div className="setting-row">
          <label>Volume:</label>
          <div className="volume-control">
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => setVolume(parseInt(e.target.value))}
            />
            <span>{volume}%</span>
          </div>
        </div>

        <button className="test-alarm" onClick={handleTestAlarm}>
          Test Alarm
        </button>
      </div>

      <div className="chain-info">
        {apiMode ? (
          <>
            <strong>Auto Mode:</strong><br />
            Syncs with Torn API (updates ~every 30s).<br />
            Local countdown runs between syncs.<br />
            Alarm at {alarmThreshold}s, 15s, 10s, 5s remaining.
          </>
        ) : (
          <>
            <strong>How to use:</strong><br />
            Click "Start" when your chain begins.<br />
            Click "Reset (Hit!)" after each attack.<br />
            Alarm sounds when time is running low!<br />
            <br />
            <strong>Shortcuts:</strong> Space = Reset, S = Start, X/Esc = Stop
          </>
        )}
      </div>
    </div>
  )
}

export default App
