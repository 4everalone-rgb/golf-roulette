'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { QRCodeSVG } from 'qrcode.react'
import { motion, AnimatePresence } from 'framer-motion'

// ============ TYPES ============
interface Player {
  id: string
  name: string
  avatar: string
  scores: Record<number, number>
  handicaps: Record<number, HandicapResult>
}

interface Handicap {
  id: string
  name: string
  description: string
  emoji: string
  severity: number
}

interface HandicapResult {
  playerId: string
  playerName: string
  handicap: Handicap
}

interface GameState {
  id: string
  code: string
  hostId: string
  players: Player[]
  currentHole: number
  totalHoles: number
  status: 'lobby' | 'playing' | 'finished'
  spinning: boolean
  currentHandicap: HandicapResult | null
  scoresEntered: string[]
}

// ============ AVATARS ============
const AVATARS = ['🏌️', '🧑‍🦱', '👨‍🦰', '🧔', '👩', '🧑', '👴', '👦', '🦊', '🐻', '🦁', '🐸', '🐧', '🦅', '🦄', '🐲']

// ============ SOUND FX TEXT ============
const SOUND_FX = ['POW!', 'BAM!', 'ZAP!', 'WHAM!', 'BOOM!', 'KAPOW!']

// ============ MAIN APP ============

function getInitialJoinCode(): string {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  const joinParam = params.get('join')
  return joinParam && joinParam.length === 5 ? joinParam.toUpperCase() : ''
}

function getInitialScreen(): 'home' | 'create' | 'join' | 'lobby' | 'game' | 'scorecard' | 'gameover' {
  if (typeof window === 'undefined') return 'home'
  // If we have a saved game, go straight to reconnect view
  const saved = localStorage.getItem('golfroulette_session')
  if (saved) return 'reconnecting'
  const params = new URLSearchParams(window.location.search)
  const joinParam = params.get('join')
  return joinParam && joinParam.length === 5 ? 'join' : 'home'
}

export default function GolfRoulette() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [screen, setScreen] = useState<'home' | 'create' | 'join' | 'lobby' | 'game' | 'scorecard' | 'gameover' | 'reconnecting'>(getInitialScreen)
  const [gameId, setGameId] = useState('')
  const [playerId, setPlayerId] = useState('')
  const [game, setGame] = useState<GameState | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [selectedAvatar, setSelectedAvatar] = useState('🏌️')
  const [joinCode, setJoinCode] = useState(getInitialJoinCode)
  const [totalHoles, setTotalHoles] = useState(9)
  const [error, setError] = useState('')
  const [eventMessage, setEventMessage] = useState('')
  const [spinning, setSpinning] = useState(false)
  const [wheelResult, setWheelResult] = useState<HandicapResult | null>(null)
  const [wheelPlayers, setWheelPlayers] = useState<{ id: string; name: string; avatar: string }[]>([])
  const [showHandicap, setShowHandicap] = useState(false)
  const [scoreInput, setScoreInput] = useState('')
  const [showScorecard, setShowScorecard] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [flashFx, setFlashFx] = useState('')

  const flashTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // ============ LOCALSTORAGE PERSISTENCE ============
  const saveSession = useCallback((gId: string, pId: string) => {
    localStorage.setItem('golfroulette_session', JSON.stringify({ gameId: gId, playerId: pId }))
    console.log('[SESSION] Saved:', gId, pId)
  }, [])

  const clearSession = useCallback(() => {
    localStorage.removeItem('golfroulette_session')
    console.log('[SESSION] Cleared')
  }, [])

  const loadSession = useCallback((): { gameId: string; playerId: string } | null => {
    try {
      const raw = localStorage.getItem('golfroulette_session')
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }, [])

  // ============ SOCKET CONNECTION ============
  useEffect(() => {
    // In production, connect to the Render WebSocket server directly
    // In development, use the Caddy gateway with XTransformPort
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || ''
    const isProduction = !!wsUrl

    const socketOptions: Record<string, unknown> = {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    }

    // In dev, we use the Caddy proxy path. In prod, we connect directly.
    const socketInstance = isProduction
      ? io(wsUrl, { ...socketOptions, path: '/socket' })
      : io('/?XTransformPort=3003', socketOptions)

    // On connect: set state + auto-rejoin if we have a saved session
    socketInstance.on('connect', () => {
      setSocket(socketInstance)
      setConnected(true)
      console.log('[SOCKET] Connected:', socketInstance.id)

      // Auto-rejoin saved game
      const saved = localStorage.getItem('golfroulette_session')
      if (saved) {
        try {
          const { gameId: savedGameId, playerId: savedPlayerId } = JSON.parse(saved)
          if (savedGameId && savedPlayerId) {
            console.log('[RECONNECT] Auto-rejoining game:', savedGameId)
            socketInstance.emit('rejoin-game', { gameId: savedGameId, playerId: savedPlayerId })
          }
        } catch (e) {
          localStorage.removeItem('golfroulette_session')
        }
      }
    })

    socketInstance.on('disconnect', () => {
      setConnected(false)
      console.log('[SOCKET] Disconnected')
    })

    socketInstance.on('game-created', (data: { gameId: string; playerId: string; code: string; game: GameState }) => {
      setGameId(data.gameId)
      setPlayerId(data.playerId)
      setGame(data.game)
      setScreen('lobby')
      setEventMessage('🎮 GAME CREATED! Share the code!')
      saveSession(data.gameId, data.playerId)
    })

    socketInstance.on('game-joined', (data: { gameId: string; playerId: string; game: GameState }) => {
      setGameId(data.gameId)
      setPlayerId(data.playerId)
      setGame(data.game)
      setScreen('lobby')
      setEventMessage('🎮 JOINED! Waiting for host to start...')
      saveSession(data.gameId, data.playerId)
    })

    socketInstance.on('game-updated', (data: { game: GameState; event: string }) => {
      setGame(data.game)
      setEventMessage(data.event)
      if (data.game.status === 'playing') {
        setScreen('game')
      } else if (data.game.status === 'finished') {
        setScreen('gameover')
      }
    })

    // Dedicated hole-advance event from server
    socketInstance.on('hole-advance', (data: { game: GameState; event: string; hole: number }) => {
      console.log('[SOCKET] Hole advance to:', data.hole)
      setGame(data.game)
      setEventMessage(data.event)
      setScreen('game')
      // Reset wheel state for new hole
      setWheelResult(null)
      setShowHandicap(false)
      setSpinning(false)
      setScoreInput('')
    })

    socketInstance.on('wheel-spin-start', (data: { players: { id: string; name: string; avatar: string }[] }) => {
      setSpinning(true)
      setWheelPlayers(data.players)
      setWheelResult(null)
      setShowHandicap(false)
      setFlashFx(SOUND_FX[Math.floor(Math.random() * SOUND_FX.length)])
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = setTimeout(() => setFlashFx(''), 1000)
    })

    socketInstance.on('wheel-spin-result', (data: { result: HandicapResult; game: GameState }) => {
      setSpinning(false)
      setWheelResult(data.result)
      setGame(data.game)
      setTimeout(() => setShowHandicap(true), 500)
    })

    socketInstance.on('error-message', (data: { message: string }) => {
      setError(data.message)
      setTimeout(() => setError(''), 4000)
    })

    socketInstance.on('game-rejoined', (data: { playerId: string; game: GameState }) => {
      setPlayerId(data.playerId)
      setGame(data.game)
      saveSession(data.game.id, data.playerId)
      if (data.game.status === 'lobby') setScreen('lobby')
      else if (data.game.status === 'playing') setScreen('game')
      else if (data.game.status === 'finished') setScreen('gameover')
      setEventMessage('🔄 RECONNECTED! Welcome back!')
    })

    return () => {
      socketInstance.disconnect()
    }
  }, [saveSession])

  // ============ ACTIONS ============
  const createGame = useCallback(() => {
    if (!socket || !playerName.trim()) return
    socket.emit('create-game', {
      playerName: playerName.trim(),
      avatar: selectedAvatar,
      totalHoles,
    })
  }, [socket, playerName, selectedAvatar, totalHoles])

  const joinGame = useCallback(() => {
    if (!socket || !playerName.trim() || !joinCode.trim()) return
    socket.emit('join-game', {
      code: joinCode.trim().toUpperCase(),
      playerName: playerName.trim(),
      avatar: selectedAvatar,
    })
  }, [socket, playerName, joinCode, selectedAvatar])

  const startGame = useCallback(() => {
    if (!socket || !gameId || !playerId) return
    socket.emit('start-game', { gameId, playerId })
  }, [socket, gameId, playerId])

  const spinWheel = useCallback(() => {
    if (!socket || !gameId) return
    socket.emit('spin-wheel', { gameId })
  }, [socket, gameId])

  const enterScore = useCallback(() => {
    if (!socket || !gameId || !playerId || !game) return
    const strokes = parseInt(scoreInput)
    if (isNaN(strokes) || strokes < 1 || strokes > 20) return
    socket.emit('enter-score', {
      gameId,
      playerId,
      hole: game.currentHole,
      strokes,
    })
    setScoreInput('')
  }, [socket, gameId, playerId, game, scoreInput])

  const getPlayerTotal = useCallback((player: Player) => {
    return Object.values(player.scores).reduce((sum, s) => sum + s, 0)
  }, [])

  const isHost = useCallback(() => {
    return game?.hostId === playerId
  }, [game, playerId])

  const leaveGame = useCallback(() => {
    if (socket) socket.emit('leave-game')
    clearSession()
    setGame(null)
    setGameId('')
    setPlayerId('')
    setScreen('home')
    setEventMessage('')
    setWheelResult(null)
    setShowHandicap(false)
  }, [socket, clearSession])

  const hasEnteredScore = useCallback(() => {
    return game?.scoresEntered.includes(playerId)
  }, [game, playerId])

  // ============ RENDER HELPERS ============
  const renderHeader = () => (
    <div className="text-center mb-6">
      <h1 className="font-[var(--font-arcade)] text-xl sm:text-2xl md:text-3xl neon-green animate-pulse-neon mb-2 leading-relaxed">
        GOLF ROULETTE
      </h1>
      <p className="font-[var(--font-arcade)] text-[10px] sm:text-xs neon-pink">🎰 HANDICAP MADNESS ⛳</p>
      {!connected && (
        <p className="font-[var(--font-arcade)] text-[10px] text-red-400 mt-2 animate-blink">
          CONNECTING...
        </p>
      )}
    </div>
  )

  // ============ HOME SCREEN ============
  const renderHome = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 arcade-screen">
      <div className="crt-overlay" />
      
      {/* Star background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 50 }).map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 bg-white rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              opacity: 0.2 + Math.random() * 0.5,
              animation: `twinkle ${2 + Math.random() * 3}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 2}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 w-full max-w-md">
        {renderHeader()}

        {/* Arcade Cabinet Frame */}
        <div className="pixel-border p-6 sm:p-8 bg-[#0a0a1a] rounded-lg mb-6">
          <div className="text-center mb-8">
            <div className="text-6xl sm:text-7xl mb-4">⛳</div>
            <p className="font-[var(--font-retro)] text-lg text-[#00ffff] mb-2">
              Spin the wheel. Suffer the consequences.
            </p>
            <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa]">
              UP TO 8 PLAYERS • 9 OR 18 HOLES • CHAOS GUARANTEED
            </p>
          </div>

          <div className="space-y-4">
            <button
              onClick={() => { setScreen('create'); setError('') }}
              className="arcade-btn-green arcade-btn w-full text-sm sm:text-base"
              disabled={!connected}
            >
              🎮 CREATE GAME
            </button>
            <button
              onClick={() => { setScreen('join'); setError('') }}
              className="arcade-btn-cyan arcade-btn w-full text-sm sm:text-base"
              disabled={!connected}
            >
              🔗 JOIN GAME
            </button>
          </div>
        </div>

        {/* Credits */}
        <div className="text-center">
          <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa] animate-blink">
            INSERT COIN TO CONTINUE
          </p>
        </div>
      </div>
    </div>
  )

  // ============ AVATAR SELECTOR ============
  const renderAvatarSelector = () => (
    <div className="mb-4">
      <label className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] block mb-2">CHOOSE YOUR PLAYER</label>
      <div className="grid grid-cols-8 gap-2">
        {AVATARS.map((avatar) => (
          <button
            key={avatar}
            onClick={() => setSelectedAvatar(avatar)}
            className={`text-2xl p-2 rounded border-2 transition-all ${
              selectedAvatar === avatar
                ? 'border-[#ff0080] bg-[#ff0080]/20 scale-110'
                : 'border-[#3333aa] bg-[#111133] hover:border-[#4444cc]'
            }`}
          >
            {avatar}
          </button>
        ))}
      </div>
    </div>
  )

  // ============ CREATE SCREEN ============
  const renderCreate = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 arcade-screen">
      <div className="crt-overlay" />
      <div className="relative z-10 w-full max-w-md">
        {renderHeader()}
        <div className="pixel-border p-6 bg-[#0a0a1a] rounded-lg">
          <h2 className="font-[var(--font-arcade)] text-sm neon-cyan text-center mb-6">CREATE GAME</h2>

          {renderAvatarSelector()}

          <div className="mb-4">
            <label className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] block mb-2">PLAYER NAME</label>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter your name..."
              maxLength={12}
              className="w-full bg-[#1a1a4e] border-2 border-[#3333aa] text-[#00ff41] font-[var(--font-retro)] text-lg px-4 py-3 rounded focus:border-[#ff0080] focus:outline-none placeholder:text-[#6688aa]"
            />
          </div>

          <div className="mb-6">
            <label className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] block mb-2">NUMBER OF HOLES</label>
            <div className="flex gap-4">
              <button
                onClick={() => setTotalHoles(9)}
                className={`flex-1 arcade-btn text-sm ${totalHoles === 9 ? 'arcade-btn-yellow' : 'opacity-50'}`}
              >
                9 HOLES
              </button>
              <button
                onClick={() => setTotalHoles(18)}
                className={`flex-1 arcade-btn text-sm ${totalHoles === 18 ? 'arcade-btn-yellow' : 'opacity-50'}`}
              >
                18 HOLES
              </button>
            </div>
          </div>

          {error && (
            <p className="font-[var(--font-arcade)] text-[10px] text-[#ff3333] text-center mb-4 animate-blink">{error}</p>
          )}

          <div className="space-y-3">
            <button
              onClick={createGame}
              disabled={!connected || !playerName.trim()}
              className="arcade-btn-green arcade-btn w-full text-sm"
            >
              🏌️ TEE OFF!
            </button>
            <button
              onClick={() => setScreen('home')}
              className="arcade-btn w-full text-[10px] opacity-70"
            >
              ← BACK
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ============ JOIN SCREEN ============
  const renderJoin = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 arcade-screen">
      <div className="crt-overlay" />
      <div className="relative z-10 w-full max-w-md">
        {renderHeader()}
        <div className="pixel-border p-6 bg-[#0a0a1a] rounded-lg">
          <h2 className="font-[var(--font-arcade)] text-sm neon-cyan text-center mb-6">JOIN GAME</h2>

          {renderAvatarSelector()}

          <div className="mb-4">
            <label className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] block mb-2">PLAYER NAME</label>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter your name..."
              maxLength={12}
              className="w-full bg-[#1a1a4e] border-2 border-[#3333aa] text-[#00ff41] font-[var(--font-retro)] text-lg px-4 py-3 rounded focus:border-[#ff0080] focus:outline-none placeholder:text-[#6688aa]"
            />
          </div>

          <div className="mb-6">
            <label className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] block mb-2">GAME CODE</label>
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ENTER 5-DIGIT CODE"
              maxLength={5}
              className="w-full bg-[#1a1a4e] border-2 border-[#3333aa] text-[#ffff00] font-[var(--font-arcade)] text-2xl px-4 py-3 rounded text-center tracking-[0.3em] focus:border-[#ff0080] focus:outline-none placeholder:text-[#6688aa] placeholder:text-sm placeholder:tracking-normal"
            />
          </div>

          {error && (
            <p className="font-[var(--font-arcade)] text-[10px] text-[#ff3333] text-center mb-4 animate-blink">{error}</p>
          )}

          <div className="space-y-3">
            <button
              onClick={joinGame}
              disabled={!connected || !playerName.trim() || joinCode.length < 5}
              className="arcade-btn-cyan arcade-btn w-full text-sm"
            >
              🔗 JOIN THE GAME!
            </button>
            <button
              onClick={() => setScreen('home')}
              className="arcade-btn w-full text-[10px] opacity-70"
            >
              ← BACK
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ============ LOBBY SCREEN ============
  const renderLobby = () => (
    <div className="flex flex-col items-center min-h-screen p-4 arcade-screen">
      <div className="crt-overlay" />
      <div className="relative z-10 w-full max-w-md">
        {renderHeader()}
        <div className="pixel-border p-6 bg-[#0a0a1a] rounded-lg">
          <h2 className="font-[var(--font-arcade)] text-sm neon-yellow text-center mb-2">WAITING ROOM</h2>

          {/* Game Code */}
          <div className="text-center mb-6">
            <p className="font-[var(--font-arcade)] text-[10px] text-[#6688aa] mb-1">GAME CODE</p>
            <div className="font-[var(--font-arcade)] text-3xl sm:text-4xl neon-pink tracking-[0.2em] animate-pulse-neon">
              {game?.code}
            </div>
            <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa] mt-2">
              Share this code with your buddies!
            </p>
          </div>

          {/* QR Code Toggle */}
          <div className="text-center mb-6">
            <button
              onClick={() => setShowQR(!showQR)}
              className="arcade-btn text-[10px]"
            >
              {showQR ? 'HIDE QR CODE' : '📷 SHOW QR CODE'}
            </button>
            {showQR && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="mt-4 inline-block p-4 bg-white rounded-lg"
              >
                <QRCodeSVG
                  value={`${typeof window !== 'undefined' ? window.location.origin : ''}?join=${game?.code || ''}`}
                  size={180}
                  bgColor="#ffffff"
                  fgColor="#0a0a1a"
                  level="M"
                />
              </motion.div>
            )}
          </div>

          {/* Players List */}
          <div className="mb-6">
            <p className="font-[var(--font-arcade)] text-[10px] text-[#00ffff] mb-3">
              PLAYERS ({game?.players.length || 0}/8)
            </p>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {game?.players.map((player, i) => (
                <motion.div
                  key={player.id}
                  initial={{ x: -50, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: i * 0.1 }}
                  className="flex items-center gap-3 bg-[#1a1a4e] border-2 border-[#3333aa] rounded p-3"
                >
                  <span className="text-2xl">{player.avatar}</span>
                  <span className="font-[var(--font-retro)] text-lg text-[#00ff41] flex-1">{player.name}</span>
                  {player.id === game.hostId && (
                    <span className="font-[var(--font-arcade)] text-[8px] text-[#ffff00] bg-[#ffff00]/10 px-2 py-1 rounded">
                      HOST
                    </span>
                  )}
                  {player.id === playerId && (
                    <span className="font-[var(--font-arcade)] text-[8px] text-[#ff0080] bg-[#ff0080]/10 px-2 py-1 rounded">
                      YOU
                    </span>
                  )}
                </motion.div>
              ))}
            </div>
          </div>

          {/* Event Message */}
          {eventMessage && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center mb-4"
            >
              <p className="font-[var(--font-retro)] text-sm text-[#ffff00]">{eventMessage}</p>
            </motion.div>
          )}

          {/* Start Button (host only) */}
          {isHost() ? (
            <button
              onClick={startGame}
              disabled={game && game.players.length < 2}
              className="arcade-btn-green arcade-btn w-full text-sm"
            >
              🏌️ START GAME!
            </button>
          ) : (
            <div className="text-center">
              <p className="font-[var(--font-arcade)] text-[10px] text-[#6688aa] animate-blink">
                WAITING FOR HOST TO START...
              </p>
            </div>
          )}

          {game && game.players.length < 2 && isHost() && (
            <p className="font-[var(--font-arcade)] text-[10px] text-[#ff3333] text-center mt-2">
              NEED AT LEAST 2 PLAYERS TO START
            </p>
          )}
        </div>
      </div>
    </div>
  )

  // ============ SPINNING WHEEL ============
  const renderSpinningWheel = () => {
    if (!game || game.status !== 'playing') return null

    const currentHandicap = game.currentHandicap
    const players = wheelPlayers.length > 0 ? wheelPlayers : game.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar }))
    const SEGMENT_COLORS = ['#ff0080', '#00ff41', '#00ffff', '#ffff00', '#ff6600', '#ff00ff', '#0088ff', '#88ff00']

    return (
      <div className="pixel-border p-4 sm:p-6 bg-[#0a0a1a] rounded-lg mb-4">
        <h3 className="font-[var(--font-arcade)] text-[10px] sm:text-xs neon-yellow text-center mb-4">
          HOLE {game.currentHole} - HANDICAP ROULETTE
        </h3>

        {/* Wheel Area */}
        <div className="flex flex-col items-center relative">
          {spinning ? (
            <div className="relative w-64 h-64 sm:w-72 sm:h-72 mb-4">
              {/* SVG Wheel */}
              <svg viewBox="0 0 300 300" className="w-full h-full" style={{ animation: 'spin 0.15s linear infinite' }}>
                {players.map((p, i) => {
                  const angle = (360 / players.length) * i
                  const startAngle = (angle - 90) * (Math.PI / 180)
                  const endAngle = ((angle + 360 / players.length) - 90) * (Math.PI / 180)
                  const x1 = 150 + 140 * Math.cos(startAngle)
                  const y1 = 150 + 140 * Math.sin(startAngle)
                  const x2 = 150 + 140 * Math.cos(endAngle)
                  const y2 = 150 + 140 * Math.sin(endAngle)
                  const largeArc = 360 / players.length > 180 ? 1 : 0
                  const midAngle = (angle + 360 / players.length / 2 - 90) * (Math.PI / 180)
                  const textX = 150 + 90 * Math.cos(midAngle)
                  const textY = 150 + 90 * Math.sin(midAngle)
                  return (
                    <g key={p.id}>
                      <path
                        d={`M 150 150 L ${x1} ${y1} A 140 140 0 ${largeArc} 1 ${x2} ${y2} Z`}
                        fill={SEGMENT_COLORS[i % SEGMENT_COLORS.length]}
                        stroke="#0a0a1a"
                        strokeWidth="2"
                        opacity="0.85"
                      />
                      <text
                        x={textX}
                        y={textY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize="28"
                        transform={`rotate(${angle + 360 / players.length / 2}, ${textX}, ${textY})`}
                      >
                        {p.avatar}
                      </text>
                      <text
                        x={textX}
                        y={textY + 18}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize="8"
                        fill="#0a0a1a"
                        fontWeight="bold"
                        fontFamily="monospace"
                        transform={`rotate(${angle + 360 / players.length / 2}, ${textX}, ${textY + 18})`}
                      >
                        {p.name.substring(0, 6).toUpperCase()}
                      </text>
                    </g>
                  )
                })}
                {/* Center circle */}
                <circle cx="150" cy="150" r="30" fill="#1a1a4e" stroke="#ff0080" strokeWidth="3" />
                <text x="150" y="155" textAnchor="middle" fontSize="24">🎰</text>
                {/* Outer ring */}
                <circle cx="150" cy="150" r="142" fill="none" stroke="#ff0080" strokeWidth="4" />
                <circle cx="150" cy="150" r="146" fill="none" stroke="#ff66b2" strokeWidth="2" />
                {/* Light dots around rim */}
                {Array.from({ length: 24 }).map((_, i) => {
                  const dotAngle = (360 / 24) * i * (Math.PI / 180)
                  return (
                    <circle
                      key={i}
                      cx={150 + 144 * Math.cos(dotAngle - Math.PI / 2)}
                      cy={150 + 144 * Math.sin(dotAngle - Math.PI / 2)}
                      r="3"
                      fill={i % 2 === 0 ? '#ffff00' : '#ff0080'}
                      opacity={0.8}
                    />
                  )
                })}
              </svg>
              {/* Pointer */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 text-4xl z-10 drop-shadow-lg">▼</div>
            </div>
          ) : showHandicap && wheelResult ? (
            <motion.div
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', duration: 0.8 }}
              className="text-center mb-4"
            >
              <div className="text-5xl sm:text-6xl mb-3">{wheelResult.handicap.emoji}</div>
              <p className="font-[var(--font-arcade)] text-[10px] sm:text-xs text-[#ff3333] mb-2">
                ⚠️ {wheelResult.playerName} IS CURSED! ⚠️
              </p>
              <div className="bg-[#1a1a4e] border-2 border-[#ff0080] rounded p-4 mb-2">
                <p className="font-[var(--font-arcade)] text-xs sm:text-sm neon-pink mb-2">
                  {wheelResult.handicap.name}
                </p>
                <p className="font-[var(--font-retro)] text-sm sm:text-base text-[#00ffff]">
                  {wheelResult.handicap.description}
                </p>
              </div>
              <div className="flex justify-center gap-1 mb-2">
                {Array.from({ length: wheelResult.handicap.severity }).map((_, i) => (
                  <span key={i} className="text-lg">💀</span>
                ))}
              </div>
              <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa]">
                DIFFICULTY: {['EASY', 'MEDIUM', 'BRUTAL'][wheelResult.handicap.severity - 1]}
              </p>
            </motion.div>
          ) : currentHandicap ? (
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">{currentHandicap.handicap.emoji}</div>
              <p className="font-[var(--font-arcade)] text-[10px] text-[#ff3333] mb-1">
                {currentHandicap.playerName}
              </p>
              <p className="font-[var(--font-arcade)] text-xs neon-pink">
                {currentHandicap.handicap.name}
              </p>
              <p className="font-[var(--font-retro)] text-sm text-[#00ffff]">
                {currentHandicap.handicap.description}
              </p>
            </div>
          ) : (
            <div className="text-center mb-4">
              <div className="text-5xl mb-3">🎡</div>
              <p className="font-[var(--font-arcade)] text-[10px] text-[#6688aa]">
                NO HANDICAP SPUN YET
              </p>
            </div>
          )}

          {/* Flash FX */}
          <AnimatePresence>
            {flashFx && (
              <motion.div
                initial={{ scale: 3, opacity: 1 }}
                animate={{ scale: 1, opacity: 0 }}
                transition={{ duration: 0.6 }}
                className="font-[var(--font-arcade)] text-5xl sm:text-6xl neon-pink fixed inset-0 flex items-center justify-center pointer-events-none z-50"
              >
                {flashFx}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Spin Button */}
          {!spinning && !currentHandicap && isHost() && (
            <button
              onClick={spinWheel}
              className="arcade-btn-yellow arcade-btn text-sm sm:text-base animate-pulse-neon"
            >
              🎰 SPIN THE WHEEL!
            </button>
          )}
          {spinning && (
            <p className="font-[var(--font-arcade)] text-[10px] neon-yellow animate-blink">
              🎰 SPINNING...
            </p>
          )}
          {!spinning && currentHandicap && !isHost() && (
            <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa]">
              WAITING FOR HOST TO SPIN...
            </p>
          )}
        </div>
      </div>
    )
  }

  // ============ SCORE ENTRY ============
  const renderScoreEntry = () => {
    if (!game || game.status !== 'playing') return null

    return (
      <div className="pixel-border p-4 sm:p-6 bg-[#0a0a1a] rounded-lg">
        <h3 className="font-[var(--font-arcade)] text-[10px] sm:text-xs neon-green text-center mb-4">
          HOLE {game.currentHole} - ENTER YOUR SCORE
        </h3>

        {hasEnteredScore() ? (
          <div className="text-center">
            <div className="text-4xl mb-2">✅</div>
            <p className="font-[var(--font-arcade)] text-[10px] text-[#00ff41]">
              SCORE ENTERED! WAITING FOR OTHERS...
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {game.players.map((p) => (
                <div
                  key={p.id}
                  className={`text-2xl p-1 rounded ${
                    game.scoresEntered.includes(p.id) ? 'opacity-100' : 'opacity-30'
                  }`}
                >
                  {p.avatar}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setScoreInput(String(Math.max(1, (parseInt(scoreInput) || 0) - 1)))}
                className="arcade-btn text-lg px-4 py-2"
              >
                -
              </button>
              <div className="w-20 h-20 flex items-center justify-center bg-[#1a1a4e] border-2 border-[#00ff41] rounded">
                <span className="font-[var(--font-arcade)] text-3xl neon-green">
                  {scoreInput || '-'}
                </span>
              </div>
              <button
                onClick={() => setScoreInput(String(Math.min(20, (parseInt(scoreInput) || 0) + 1)))}
                className="arcade-btn text-lg px-4 py-2"
              >
                +
              </button>
            </div>
            <div className="flex gap-2 flex-wrap justify-center">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setScoreInput(String(n))}
                  className={`arcade-btn text-xs px-3 py-2 ${scoreInput === String(n) ? 'arcade-btn-green' : ''}`}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              onClick={enterScore}
              disabled={!scoreInput || parseInt(scoreInput) < 1}
              className="arcade-btn-green arcade-btn text-sm w-full"
            >
              ✅ SUBMIT SCORE
            </button>
          </div>
        )}
      </div>
    )
  }

  // ============ MINI SCORECARD (in game) ============
  const renderMiniScorecard = () => {
    if (!game) return null

    return (
      <div className="pixel-border p-3 bg-[#0a0a1a] rounded-lg mb-4 max-h-48 overflow-y-auto">
        <h3 className="font-[var(--font-arcade)] text-[8px] sm:text-[10px] text-[#00ffff] text-center mb-2">
          📊 SCORECARD
        </h3>
        <table className="w-full scorecard-grid text-xs sm:text-sm">
          <thead>
            <tr>
              <th className="text-left text-[8px] sm:text-[10px]">Player</th>
              {Array.from({ length: game.currentHole }, (_, i) => (
                <th key={i + 1} className="text-[8px] sm:text-[10px] min-w-[30px]">{i + 1}</th>
              ))}
              <th className="text-[8px] sm:text-[10px]">TOT</th>
            </tr>
          </thead>
          <tbody>
            {game.players.map((player) => (
              <tr key={player.id}>
                <td className="text-left text-[10px] sm:text-xs">
                  {player.avatar} {player.name}
                </td>
                {Array.from({ length: game.currentHole }, (_, i) => (
                  <td key={i + 1} className="text-[10px] sm:text-xs">
                    {player.scores[i + 1] !== undefined ? player.scores[i + 1] : '-'}
                  </td>
                ))}
                <td className="text-[10px] sm:text-xs font-bold text-[#ffff00]">
                  {getPlayerTotal(player)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // ============ GAME SCREEN ============
  const renderGame = () => (
    <div className="flex flex-col min-h-screen p-3 sm:p-4 arcade-screen">
      <div className="crt-overlay" />
      <div className="relative z-10 w-full max-w-md mx-auto">
        {/* Top Bar */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-[var(--font-arcade)] text-[10px] sm:text-xs neon-green">
              HOLE {game?.currentHole}/{game?.totalHoles}
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowScorecard(!showScorecard)}
              className="arcade-btn text-[8px] sm:text-[10px] px-2 py-1"
            >
              📊
            </button>
          </div>
        </div>

        {/* Players Strip */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
          {game?.players.map((player) => {
            const isCursed = game.currentHandicap?.playerId === player.id
            const hasScored = game.scoresEntered.includes(player.id)
            return (
              <motion.div
                key={player.id}
                className={`flex flex-col items-center p-2 rounded border-2 min-w-[60px] ${
                  isCursed
                    ? 'border-[#ff0080] bg-[#ff0080]/10'
                    : hasScored
                    ? 'border-[#00ff41] bg-[#00ff41]/10'
                    : 'border-[#3333aa] bg-[#111133]'
                } ${player.id === playerId ? 'ring-2 ring-[#ffff00]' : ''}`}
              >
                <span className="text-2xl">{player.avatar}</span>
                <span className="font-[var(--font-arcade)] text-[7px] text-[#00ffff] truncate max-w-[60px]">
                  {player.name}
                </span>
                {isCursed && <span className="text-sm">💀</span>}
                {hasScored && <span className="text-sm">✅</span>}
              </motion.div>
            )
          })}
        </div>

        {/* Event Message */}
        {eventMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-3"
          >
            <p className="font-[var(--font-retro)] text-sm text-[#ffff00]">{eventMessage}</p>
          </motion.div>
        )}

        {/* Scorecard Toggle */}
        {showScorecard && renderMiniScorecard()}

        {/* Spinning Wheel + Handicap */}
        {renderSpinningWheel()}

        {/* Score Entry */}
        {game?.currentHandicap && renderScoreEntry()}
      </div>
    </div>
  )

  // ============ GAME OVER SCREEN ============
  const renderGameOver = () => {
    if (!game) return null
    const sorted = [...game.players].sort((a, b) => getPlayerTotal(a) - getPlayerTotal(b))
    const winner = sorted[0]

    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 arcade-screen">
        <div className="crt-overlay" />
        <div className="relative z-10 w-full max-w-md">
          {/* Winner Announcement */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', duration: 1 }}
            className="text-center mb-6"
          >
            <div className="text-6xl sm:text-7xl mb-3">🏆</div>
            <h1 className="font-[var(--font-arcade)] text-lg sm:text-xl neon-yellow mb-2">GAME OVER!</h1>
            <div className="text-5xl mb-2">{winner.avatar}</div>
            <p className="font-[var(--font-arcade)] text-sm neon-green">{winner.name}</p>
            <p className="font-[var(--font-arcade)] text-[10px] text-[#00ffff]">
              WINS WITH {getPlayerTotal(winner)} STROKES!
            </p>
          </motion.div>

          {/* Final Standings */}
          <div className="pixel-border p-4 bg-[#0a0a1a] rounded-lg mb-4">
            <h3 className="font-[var(--font-arcade)] text-[10px] neon-pink text-center mb-3">FINAL STANDINGS</h3>
            <div className="space-y-2">
              {sorted.map((player, i) => (
                <motion.div
                  key={player.id}
                  initial={{ x: -100, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: 0.3 + i * 0.2 }}
                  className={`flex items-center gap-3 p-3 rounded border-2 ${
                    i === 0
                      ? 'border-[#ffff00] bg-[#ffff00]/10'
                      : i === 1
                      ? 'border-[#cccccc] bg-[#cccccc]/5'
                      : i === 2
                      ? 'border-[#cd7f32] bg-[#cd7f32]/5'
                      : 'border-[#3333aa] bg-[#111133]'
                  }`}
                >
                  <span className="font-[var(--font-arcade)] text-sm text-[#00ffff] w-8">
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                  </span>
                  <span className="text-2xl">{player.avatar}</span>
                  <span className="font-[var(--font-retro)] text-base text-[#00ff41] flex-1">{player.name}</span>
                  <span className="font-[var(--font-arcade)] text-sm neon-yellow">{getPlayerTotal(player)}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Full Scorecard */}
          <div className="pixel-border p-3 bg-[#0a0a1a] rounded-lg mb-4 max-h-64 overflow-y-auto">
            <h3 className="font-[var(--font-arcade)] text-[8px] text-[#00ffff] text-center mb-2">FULL SCORECARD</h3>
            <div className="overflow-x-auto">
              <table className="scorecard-grid text-xs w-full">
                <thead>
                  <tr>
                    <th className="text-left text-[8px]">Player</th>
                    {Array.from({ length: game.totalHoles }, (_, i) => (
                      <th key={i + 1} className="text-[8px] min-w-[28px]">{i + 1}</th>
                    ))}
                    <th className="text-[8px]">TOT</th>
                  </tr>
                </thead>
                <tbody>
                  {game.players.map((player) => (
                    <tr key={player.id}>
                      <td className="text-left text-[9px] whitespace-nowrap">
                        {player.avatar} {player.name}
                      </td>
                      {Array.from({ length: game.totalHoles }, (_, i) => (
                        <td key={i + 1} className="text-[9px]">
                          {player.scores[i + 1] !== undefined ? player.scores[i + 1] : '-'}
                        </td>
                      ))}
                      <td className="text-[9px] font-bold text-[#ffff00]">{getPlayerTotal(player)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Handicap Highlights */}
          <div className="pixel-border p-3 bg-[#0a0a1a] rounded-lg mb-4">
            <h3 className="font-[var(--font-arcade)] text-[8px] text-[#ff0080] text-center mb-2">HANDICAP HALL OF SHAME</h3>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {game.players.flatMap((player) =>
                Object.entries(player.handicaps).map(([hole, hc]) => (
                  <div key={`${player.id}-${hole}`} className="flex items-center gap-2 text-[10px]">
                    <span className="text-sm">{hc.handicap.emoji}</span>
                    <span className="text-[#00ffff]">H{hole}</span>
                    <span className="text-[#00ff41]">{player.name}</span>
                    <span className="text-[#ff0080]">{hc.handicap.name}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Play Again */}
          <button
            onClick={leaveGame}
            className="arcade-btn-green arcade-btn w-full text-sm"
          >
            🎮 PLAY AGAIN!
          </button>
        </div>
      </div>
    )
  }

  // ============ RECONNECTING SCREEN ============
  const renderReconnecting = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 arcade-screen">
      <div className="crt-overlay" />
      <div className="relative z-10 w-full max-w-md">
        {renderHeader()}
        <div className="pixel-border p-6 bg-[#0a0a1a] rounded-lg text-center">
          <div className="text-6xl mb-4">📡</div>
          <h2 className="font-[var(--font-arcade)] text-sm neon-cyan mb-4">RECONNECTING...</h2>
          <p className="font-[var(--font-retro)] text-base text-[#00ffff] mb-4">
            Finding your game...
          </p>
          <p className="font-[var(--font-arcade)] text-[8px] text-[#6688aa] mb-6 animate-blink">
            YOUR GAME IS STILL RUNNING
          </p>
          <button
            onClick={leaveGame}
            className="arcade-btn w-full text-[10px] opacity-70"
          >
            ✕ LEAVE GAME
          </button>
        </div>
      </div>
    </div>
  )

  // ============ MAIN RENDER ============
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={screen}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
        className="bg-[#0a0a1a] min-h-screen"
      >
        {screen === 'home' && renderHome()}
        {screen === 'create' && renderCreate()}
        {screen === 'join' && renderJoin()}
        {screen === 'reconnecting' && renderReconnecting()}
        {screen === 'lobby' && renderLobby()}
        {screen === 'game' && renderGame()}
        {screen === 'gameover' && renderGameOver()}
      </motion.div>
    </AnimatePresence>
  )
}
