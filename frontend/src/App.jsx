import { useEffect, useState, useRef } from "react";
import api, { refreshAccessToken } from "./api";
import socket from "./socket";
import "./App.css";

// UI-only helper: initials for avatars.
const getInitials = (text = "") =>
  text
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";

// UI-only helper: stable colour per sender name (used in group chats).
const NAME_COLORS = [
  "#087f73",
  "#6f4fc4",
  "#c2410c",
  "#1d6fb8",
  "#b4236b",
  "#5f7a00",
];

const getNameColor = (text = "") => {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 997;
  }
  return NAME_COLORS[hash % NAME_COLORS.length];
};

function App() {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("user")) || null;
    } catch {
      return null;
    }
  });

  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [status, setStatus] = useState("Disconnected");
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [content, setContent] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const typingTimeoutRef = useRef(null);
  // Group creation states
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupSearchResults, setGroupSearchResults] = useState([]);
  const [selectedGroupMembers, setSelectedGroupMembers] = useState([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError, setGroupError] = useState("");
  // Group member management states
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState(null);
  const [memberError, setMemberError] = useState("");
  const [memberNotice, setMemberNotice] = useState("");

  const [authLoading, setAuthLoading] = useState(true);

  // Restore session when application starts or page refreshes
  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      try {
        const response = await refreshAccessToken();

        if (cancelled) return;

        localStorage.setItem("token", response);

        const savedUser = JSON.parse(localStorage.getItem("user") || "null");

        if (savedUser) {
          setUser(savedUser);
        } else {
          localStorage.removeItem("token");
          setUser(null);
        }
      } catch (error) {
        console.log(
          "Session restoration failed:",
          error.response?.data?.message || error.message,
        );

        localStorage.removeItem("token");
        localStorage.removeItem("user");

        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    };

    restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  // Connect Socket.IO after login.
  useEffect(() => {
    if (!user || !localStorage.getItem("token")) {
      socket.disconnect();
      setStatus("Please log in");
      return;
    }

    const onConnect = () => setStatus("Connected");

    const onDisconnect = () => {
      setStatus("Disconnected");
      setOnlineUsers([]);
    };

    const onConnectError = (err) => setStatus(err.message);

    // Receive the initial list of online users
    const handleOnlineUsers = (userIds) => {
      setOnlineUsers(userIds);
    };

    // Listen for online/offline changes
    const handleUserStatus = ({ userId, isOnline }) => {
      setOnlineUsers((previous) => {
        if (isOnline) {
          return previous.includes(userId) ? previous : [...previous, userId];
        }

        return previous.filter((id) => id !== userId);
      });
    };

    // Handle message delivery receipt updates
    const handleMessageReceiptUpdated = (data) => {
      setMessages((previous) =>
        previous.map((message) => {
          if (message.id !== data.messageId) return message;

          const receipts = message.receipts || [];

          const receiptExists = receipts.some(
            (receipt) => receipt.userId === data.userId,
          );

          return {
            ...message,
            receipts: receiptExists
              ? receipts.map((receipt) =>
                  receipt.userId === data.userId
                    ? {
                        ...receipt,
                        deliveredAt:
                          data.status === "DELIVERED"
                            ? data.deliveredAt
                            : receipt.deliveredAt,
                        readAt:
                          data.status === "READ" ? data.readAt : receipt.readAt,
                      }
                    : receipt,
                )
              : [
                  ...receipts,
                  {
                    messageId: data.messageId,
                    userId: data.userId,
                    deliveredAt: data.deliveredAt || null,
                    readAt: data.readAt || null,
                  },
                ],
          };
        }),
      );
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    socket.on("online_users", handleOnlineUsers);
    socket.on("user_status", handleUserStatus);

    socket.on("message_receipt_updated", handleMessageReceiptUpdated);

    socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);

      socket.off("online_users", handleOnlineUsers);
      socket.off("user_status", handleUserStatus);

      socket.off("message_receipt_updated", handleMessageReceiptUpdated);
      socket.off("message_receipt_updated", handleMessageReceiptUpdated);

      socket.disconnect();
    };
  }, [user]);

  // Load conversation list.
  const loadConversations = async () => {
    try {
      const response = await api.get("/conversations");
      setConversations(response.data.conversations);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load conversations");
    }
  };

  useEffect(() => {
    if (user) loadConversations();
  }, [user]);

  // Search registered users.
  const searchUsers = async (event) => {
    event.preventDefault();
    setError("");

    if (!search.trim()) {
      setUsers([]);
      return;
    }

    try {
      const response = await api.get("/users/search", {
        params: { search: search.trim() },
      });
      setUsers(response.data.users);
    } catch (err) {
      setError(err.response?.data?.message || "Could not search users");
    }
  };

  // Create a conversation or open an existing one.
  const startConversation = async (receiver) => {
    setError("");

    try {
      const response = await api.post("/conversations", {
        receiverId: receiver.id,
      });

      const conversation = response.data.conversation;

      setSelected(conversation);
      setMessages([]);
      setUsers([]);
      setSearch("");

      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Could not start conversation");
    }
  };

  // Search users for group creation
  const searchGroupUsers = async (event) => {
    event.preventDefault();
    setGroupError("");

    if (!groupSearch.trim()) {
      setGroupSearchResults([]);
      return;
    }

    try {
      const response = await api.get("/users/search", {
        params: { search: groupSearch.trim() },
      });

      // Don't show users who are already selected
      const filteredUsers = response.data.users.filter(
        (person) =>
          !selectedGroupMembers.some((member) => member.id === person.id),
      );

      setGroupSearchResults(filteredUsers);
    } catch (err) {
      setGroupError(err.response?.data?.message || "Could not search users");
    }
  };

  // Add or remove a user from selected group members
  const toggleGroupMember = (person) => {
    setSelectedGroupMembers((previous) => {
      const alreadySelected = previous.some(
        (member) => member.id === person.id,
      );

      if (alreadySelected) {
        return previous.filter((member) => member.id !== person.id);
      }

      return [...previous, person];
    });
  };

  // Create group
  const createGroup = async (event) => {
    event.preventDefault();
    setGroupError("");

    if (!groupTitle.trim()) {
      setGroupError("Please enter a group name");
      return;
    }

    if (selectedGroupMembers.length === 0) {
      setGroupError("Please select at least one member");
      return;
    }

    try {
      setGroupLoading(true);

      const response = await api.post("/conversations/group", {
        title: groupTitle.trim(),
        memberIds: selectedGroupMembers.map((member) => member.id),
      });

      const newConversation = response.data.conversation;

      // Refresh conversation list
      await loadConversations();

      // Open the newly created group
      setSelected(newConversation);
      setMessages([]);

      // Reset group creation form
      setShowGroupModal(false);
      setGroupTitle("");
      setGroupSearch("");
      setGroupSearchResults([]);
      setSelectedGroupMembers([]);
      setGroupError("");
    } catch (err) {
      setGroupError(err.response?.data?.message || "Could not create group");
    } finally {
      setGroupLoading(false);
    }
  };

  // Close and reset group modal
  const closeGroupModal = () => {
    setShowGroupModal(false);
    setGroupTitle("");
    setGroupSearch("");
    setGroupSearchResults([]);
    setSelectedGroupMembers([]);
    setGroupError("");
  };

  // Open group members modal
  const openMembersModal = () => {
    setMemberError("");
    setShowMembersModal(true);
  };

  // Close group members modal
  const closeMembersModal = () => {
    setShowMembersModal(false);
    setMemberError("");
  };

  // Remove a member from the group
  const removeGroupMember = async (memberId) => {
    if (!selected || !selected.isGroup) return;

    const confirmed = window.confirm(
      "Are you sure you want to remove this member?",
    );

    if (!confirmed) return;

    try {
      setRemovingMemberId(memberId);
      setMemberError("");

      await api.delete(`/conversations/${selected.id}/members/${memberId}`);

      // Refresh conversations after successful removal
      await loadConversations();
    } catch (err) {
      setMemberError(err.response?.data?.message || "Could not remove member");
    } finally {
      setRemovingMemberId(null);
    }
  };
  // Load history and listen for real-time messages.
  useEffect(() => {
    // A member has been removed from the group
    const handleRemovedFromGroup = (data) => {
      if (data.conversationId !== conversationId) return;

      setMemberNotice(data.message || "You have been removed from this group");

      setSelected(null);
      setMessages([]);
      setShowMembersModal(false);

      setConversations((previous) =>
        previous.filter((conversation) => conversation.id !== conversationId),
      );
    };

    // Another group member has been removed
    const handleGroupMemberRemoved = (data) => {
      if (data.conversationId !== conversationId) return;

      setSelected((previous) => {
        if (!previous || previous.id !== conversationId) return previous;

        return {
          ...previous,
          members: previous.members.filter(
            (member) => member.userId !== data.memberId,
          ),
        };
      });

      setConversations((previous) =>
        previous.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                members: conversation.members.filter(
                  (member) => member.userId !== data.memberId,
                ),
              }
            : conversation,
        ),
      );
    };

    socket.on("removed_from_group", handleRemovedFromGroup);
    socket.on("group_member_removed", handleGroupMemberRemoved);
    if (!selected || !user || !socket.connected) return;

    let cancelled = false;
    const conversationId = selected.id;

    setMessages([]);
    setChatLoading(true);

    const handleNewMessage = (message) => {
      if (message.conversationId !== conversationId) return;

      setMessages((previous) => {
        if (previous.some((item) => item.id === message.id)) {
          return previous;
        }
        return [...previous, message];
      });

      // Tell backend that we received another user's message
      if (message.senderId !== user.id) {
        socket.emit("message_delivered", message.id);
      }
      if (message.senderId !== user.id) {
        socket.emit("mark_messages_read", conversationId);
      }

      loadConversations();
    };

    socket.on("new_message", handleNewMessage);

    setIsOtherTyping(false);

    const handleUserTyping = (data) => {
      if (data.conversationId === conversationId && data.userId !== user.id) {
        setIsOtherTyping(true);
      }
    };

    const handleUserStopTyping = (data) => {
      if (data.conversationId === conversationId && data.userId !== user.id) {
        setIsOtherTyping(false);
      }
    };

    socket.on("user_typing", handleUserTyping);
    socket.on("user_stop_typing", handleUserStopTyping);

    socket.emit("join_conversation", conversationId, async (result) => {
      if (cancelled) return;

      if (result?.error) {
        setError(result.error);
        setChatLoading(false);
        return;
      }

      try {
        const response = await api.get(`/messages/${conversationId}`);

        if (!cancelled) {
          const loadedMessages = response.data.messages;

          setMessages(loadedMessages);

          // Mark incoming messages as delivered
          loadedMessages.forEach((message) => {
            const myReceipt = message.receipts?.find(
              (receipt) => receipt.userId === user.id,
            );

            if (message.senderId !== user.id && !myReceipt?.deliveredAt) {
              socket.emit("message_delivered", message.id);
            }
          });
        }
        // Mark incoming messages as read
        socket.emit("mark_messages_read", conversationId);
      } catch (err) {
        if (!cancelled) {
          setError(
            err.response?.data?.message || "Could not load chat history",
          );
        }
      } finally {
        if (!cancelled) setChatLoading(false);
      }
    });

    return () => {
      cancelled = true;

      socket.off("new_message", handleNewMessage);
      socket.off("user_typing", handleUserTyping);
      socket.off("user_stop_typing", handleUserStopTyping);

      clearTimeout(typingTimeoutRef.current);
    };
  }, [selected, user, status]);

  // Send and save a message.
  const sendMessage = async (event) => {
    event.preventDefault();

    if (!selected || !content.trim()) return;

    clearTimeout(typingTimeoutRef.current);

    if (socket.connected) {
      socket.emit("stop_typing", selected.id);
    }

    setIsOtherTyping(false);

    const messageContent = content.trim();
    setContent("");
    setError("");

    try {
      await api.post("/messages", {
        conversationId: selected.id,
        content: messageContent,
      });

      // The server broadcasts the saved message over Socket.IO.
    } catch (err) {
      setContent(messageContent);
      setError(err.response?.data?.message || "Could not send message");
    }
  };

  // Login or register.
  const handleAuth = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const endpoint = isLogin ? "/auth/login" : "/auth/register";

      const payload = isLogin ? { email, password } : { name, email, password };

      const response = await api.post(endpoint, payload);

      if (!isLogin) {
        setIsLogin(true);
        setName("");
        setPassword("");
        setError("Registration successful. Please log in.");
        return;
      }

      localStorage.setItem("token", response.data.token);
      localStorage.setItem("user", JSON.stringify(response.data.user));
      setUser(response.data.user);
      setPassword("");
    } catch (err) {
      setError(err.response?.data?.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    socket.disconnect();
    localStorage.removeItem("token");
    localStorage.removeItem("user");

    setUser(null);
    setSelected(null);
    setMessages([]);
    setConversations([]);
    setUsers([]);
    setError("");
  };

  const getOtherMember = (conversation) =>
    conversation.members.find((member) => member.userId !== user?.id)?.user;

  // UI-only helpers
  const getConversationTitle = (conversation) =>
    conversation.isGroup
      ? conversation.title || "Group chat"
      : getOtherMember(conversation)?.name || "Conversation";

  const isGroupAdmin = (conversation) => {
    if (!conversation?.isGroup) return false;

    return conversation.members?.some(
      (member) => member.userId === user?.id && member.role === "ADMIN",
    );
  };

  const isOnline = (conversation) =>
    !conversation.isGroup &&
    onlineUsers.includes(getOtherMember(conversation)?.id);

  /* ---------------------------------- AUTH --------------------------------- */

  if (authLoading) {
    return (
      <div style={{ textAlign: "center", padding: "40px" }}>
        Checking your session...
      </div>
    );
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-brand">
          <div className="brand-mark">
            <span className="logo">💬</span>
            Real-Time Chat
          </div>

          <div className="brand-copy">
            <h2>Talk to your people, the moment it matters.</h2>
            <p>
              Find anyone by name or email, start a conversation, and see
              replies arrive instantly.
            </p>
          </div>
        </section>

        <section className="auth-side">
          <div className="auth-card">
            <h1>{isLogin ? "Welcome back" : "Create your account"}</h1>
            <p>
              {isLogin
                ? "Log in to pick up your conversations."
                : "It takes less than a minute to get started."}
            </p>

            <div className="auth-tabs">
              <button
                type="button"
                className={isLogin ? "active" : ""}
                onClick={() => {
                  setIsLogin(true);
                  setError("");
                }}
              >
                Login
              </button>
              <button
                type="button"
                className={!isLogin ? "active" : ""}
                onClick={() => {
                  setIsLogin(false);
                  setError("");
                }}
              >
                Register
              </button>
            </div>

            <form onSubmit={handleAuth}>
              {!isLogin && (
                <input
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              )}

              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />

              <input
                type="password"
                placeholder="Password (8–72 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                maxLength={72}
                required
              />

              {error && <p className="error">{error}</p>}

              <button disabled={loading}>
                {loading ? "Please wait..." : isLogin ? "Login" : "Register"}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  /* ---------------------------------- CHAT --------------------------------- */

  return (
    <main className={`chat-app ${selected ? "chat-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="avatar">{getInitials(user.name)}</span>
          <div className="me">
            <h2>Chats</h2>
            <small>
              <span
                className={`status-dot ${
                  status === "Connected" ? "online" : ""
                }`}
              />
              {user.name} · {status}
            </small>
          </div>
          <button className="logout" onClick={logout}>
            Logout
          </button>
        </div>

        <form className="search-form" onSubmit={searchUsers}>
          <input
            placeholder="Search people by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        <button
          type="button"
          className="create-group-btn"
          onClick={() => {
            setShowGroupModal(true);
            setGroupError("");
          }}
        >
          <span className="plus">+</span> Create group
        </button>

        {users.length > 0 && (
          <div className="search-results">
            {users.map((person) => (
              <button
                className="person"
                key={person.id}
                onClick={() => startConversation(person)}
              >
                <span className="avatar small">{getInitials(person.name)}</span>
                <span className="person-body">
                  <strong>{person.name}</strong>
                  <small>{person.email}</small>
                </span>
                <span className="cta">Start chat</span>
              </button>
            ))}
          </div>
        )}

        <h3>Your conversations</h3>

        <div className="sidebar-list">
          {conversations.length === 0 && (
            <p className="sidebar-empty">
              No conversations yet. Search for someone above or create a group
              to get started.
            </p>
          )}

          {conversations.map((conversation) => {
            const title = getConversationTitle(conversation);

            return (
              <button
                className={`person ${
                  selected?.id === conversation.id ? "selected" : ""
                }`}
                key={conversation.id}
                onClick={() => setSelected(conversation)}
              >
                <span className="avatar-wrap">
                  <span
                    className={`avatar ${conversation.isGroup ? "group" : ""}`}
                  >
                    {getInitials(title)}
                  </span>

                  {!conversation.isGroup && (
                    <span
                      className={`presence ${
                        isOnline(conversation) ? "online" : ""
                      }`}
                      title={isOnline(conversation) ? "Online" : "Offline"}
                    />
                  )}
                </span>

                <span className="person-body">
                  <strong>{title}</strong>
                  <small>
                    {conversation.messages?.[0]?.content || "No messages yet"}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="chat-panel">
        {selected ? (
          <>
            <header className="chat-header">
              <button
                type="button"
                className="back-btn"
                aria-label="Back to chats"
                onClick={() => setSelected(null)}
              >
                ‹
              </button>

              <span className="avatar-wrap">
                <span
                  className={`avatar small ${selected.isGroup ? "group" : ""}`}
                >
                  {getInitials(getConversationTitle(selected))}
                </span>

                {!selected.isGroup && (
                  <span
                    className={`presence ${isOnline(selected) ? "online" : ""}`}
                  />
                )}
              </span>

              <div>
                <h2>{getConversationTitle(selected)}</h2>

                {selected.isGroup ? (
                  <button
                    type="button"
                    className="members-chip"
                    aria-label="View group members"
                    onClick={openMembersModal}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    {selected.members?.length || 0} members
                    <span aria-hidden="true">›</span>
                  </button>
                ) : (
                  <small className={isOnline(selected) ? "is-online" : ""}>
                    {isOnline(selected) ? "Online" : "Offline"}
                  </small>
                )}
              </div>
            </header>

            <div className="messages">
              {chatLoading && (
                <p className="loading">
                  <span className="spinner" />
                  Loading messages...
                </p>
              )}

              {!chatLoading && messages.length === 0 && (
                <p className="empty">No messages yet. Say hello!</p>
              )}

              {messages.map((message) => {
                const ownMessage = message.senderId === user.id;

                return (
                  <div
                    key={message.id}
                    className={`message ${ownMessage ? "own" : ""}`}
                  >
                    {/* Sender names only matter in groups */}
                    {selected.isGroup && !ownMessage && (
                      <small
                        style={{ color: getNameColor(message.sender?.name) }}
                      >
                        {message.sender?.name}
                      </small>
                    )}
                    <p>{message.content}</p>
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    {ownMessage && !selected.isGroup && (
                      <span
                        style={{
                          color: message.receipts?.some(
                            (receipt) => receipt.readAt,
                          )
                            ? "#2684FF"
                            : message.receipts?.some(
                                  (receipt) => receipt.deliveredAt,
                                )
                              ? "#8C8C8C"
                              : "#8C8C8C",
                          fontSize: "13px",
                          marginLeft: "5px",
                        }}
                      >
                        {message.receipts?.some((receipt) => receipt.readAt)
                          ? "✓✓"
                          : message.receipts?.some(
                                (receipt) => receipt.deliveredAt,
                              )
                            ? "✓✓"
                            : "✓"}
                      </span>
                    )}
                  </div>
                );
              })}

              {isOtherTyping && (
                <p className="typing-indicator">
                  <span className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  {getOtherMember(selected)?.name || "Someone"} is typing...
                </p>
              )}
            </div>

            <form className="message-form" onSubmit={sendMessage}>
              <input
                placeholder="Type a message..."
                value={content}
                onChange={(e) => {
                  const value = e.target.value;
                  setContent(value);

                  if (!selected || !socket.connected) return;

                  if (value.trim()) {
                    socket.emit("typing", selected.id);

                    clearTimeout(typingTimeoutRef.current);

                    typingTimeoutRef.current = setTimeout(() => {
                      socket.emit("stop_typing", selected.id);
                    }, 1000);
                  } else {
                    clearTimeout(typingTimeoutRef.current);
                    socket.emit("stop_typing", selected.id);
                  }
                }}
                maxLength={5000}
              />
              <button
                aria-label="Send message"
                disabled={!content.trim() || status !== "Connected"}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M22 2 11 13" />
                  <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
                </svg>
                <span className="send-label">Send</span>
              </button>
            </form>
          </>
        ) : (
          <div className="welcome-panel">
            <div className="welcome-icon">💬</div>
            <h1>Real-Time Chat</h1>
            <p>
              Pick a conversation from the list, or search for someone to start
              a new chat.
            </p>

            {memberNotice && (
              <div className="member-notice" role="status">
                <span>{memberNotice}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setMemberNotice("")}
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {error && <p className="chat-error">{error}</p>}
      </section>

      {/* Create group modal — rendered outside the sidebar so it never gets clipped */}
      {showGroupModal && (
        <div className="group-modal-overlay">
          <div
            className="group-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-modal-title"
          >
            <div className="group-modal-header">
              <div>
                <h2 id="group-modal-title">Create new group</h2>
                <p>Name your group, then add the people you want in it.</p>
              </div>

              <button
                type="button"
                className="group-close-btn"
                aria-label="Close"
                onClick={closeGroupModal}
              >
                ×
              </button>
            </div>

            <form className="group-form" onSubmit={createGroup}>
              <div className="field">
                <label htmlFor="group-name">Group name</label>
                <input
                  id="group-name"
                  type="text"
                  placeholder="e.g. Weekend plans"
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  maxLength={60}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="group-member-search">Add members</label>

                <div className="group-search-row">
                  <input
                    id="group-member-search"
                    type="text"
                    placeholder="Search by name or email"
                    value={groupSearch}
                    onChange={(e) => setGroupSearch(e.target.value)}
                  />

                  <button type="button" onClick={searchGroupUsers}>
                    Search
                  </button>
                </div>
              </div>

              {selectedGroupMembers.length > 0 && (
                <div className="selected-group-members">
                  <h4>Selected members ({selectedGroupMembers.length})</h4>

                  <div className="selected-member-list">
                    {selectedGroupMembers.map((person) => (
                      <div className="selected-member" key={person.id}>
                        <span>{person.name}</span>

                        <button
                          type="button"
                          aria-label={`Remove ${person.name}`}
                          onClick={() => toggleGroupMember(person)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="group-search-results">
                {groupSearchResults.map((person) => (
                  <div className="group-user-item" key={person.id}>
                    <div className="group-user-info">
                      <span className="avatar small">
                        {getInitials(person.name)}
                      </span>

                      <div>
                        <strong>{person.name}</strong>
                        <small>{person.email}</small>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => toggleGroupMember(person)}
                    >
                      Add
                    </button>
                  </div>
                ))}

                {groupSearchResults.length === 0 && groupSearch.trim() && (
                  <p className="group-empty">
                    No matches yet. Press Search to look up registered users.
                  </p>
                )}
              </div>

              {groupError && <p className="group-error">{groupError}</p>}

              <div className="group-modal-actions">
                <button
                  type="button"
                  className="group-cancel-btn"
                  onClick={closeGroupModal}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="group-create-submit"
                  disabled={groupLoading}
                >
                  {groupLoading ? "Creating..." : "Create group"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Group members modal */}
      {showMembersModal && selected?.isGroup && (
        <div className="group-modal-overlay">
          <div
            className="group-modal members-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="members-modal-title"
          >
            <div className="group-modal-header">
              <div>
                <h2 id="members-modal-title">Group members</h2>
                <p>{selected.members?.length || 0} members in this group</p>
              </div>

              <button
                type="button"
                className="group-close-btn"
                onClick={closeMembersModal}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {memberError && <p className="group-error">{memberError}</p>}

            <div className="group-members-list">
              {selected.members?.map((member) => {
                const memberUser = member.user;
                const memberOnline = onlineUsers.includes(member.userId);
                const isAdmin = member.role === "ADMIN";
                const isCurrentUser = member.userId === user.id;

                return (
                  <div className="group-member-item" key={member.id}>
                    <div className="group-member-info">
                      <span className="avatar-wrap">
                        <span className="avatar small">
                          {getInitials(memberUser?.name)}
                        </span>

                        <span
                          className={`presence ${memberOnline ? "online" : ""}`}
                        />
                      </span>

                      <div className="group-member-details">
                        <strong>
                          {memberUser?.name || "Unknown user"}
                          {isCurrentUser && (
                            <span className="you-tag"> (You)</span>
                          )}
                        </strong>

                        <small className={memberOnline ? "is-online" : ""}>
                          {memberOnline ? "Online" : "Offline"}
                        </small>
                      </div>
                    </div>

                    <div className="group-member-actions">
                      {isAdmin && <span className="admin-badge">Admin</span>}

                      {isGroupAdmin(selected) && !isCurrentUser && !isAdmin && (
                        <button
                          type="button"
                          className="remove-member-btn"
                          disabled={removingMemberId === member.userId}
                          onClick={() => removeGroupMember(member.userId)}
                        >
                          {removingMemberId === member.userId
                            ? "Removing..."
                            : "Remove"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="group-modal-actions">
              <button
                type="button"
                className="group-cancel-btn"
                onClick={closeMembersModal}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
