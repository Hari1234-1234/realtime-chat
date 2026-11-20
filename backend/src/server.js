require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");

const authRoute = require("./routes/authRoute");

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());

// Authentication routes
app.use("/api/auth", authRoute);

// --------------------------------------------------
// JWT AUTHENTICATION
// --------------------------------------------------

const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Access token required",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.userId,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }
};

// --------------------------------------------------
// SOCKET.IO
// --------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
  },
});

// Track connected sockets for each user.
// A user may have multiple browser tabs open.
const onlineUsers = new Map();

// Authenticate Socket.IO connections using the access token.
io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.auth?.accessToken ||
      socket.handshake.headers?.authorization?.replace("Bearer ", "");

    if (!token) {
      return next(new Error("Access token required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    socket.userId = decoded.userId;

    if (!socket.userId) {
      return next(new Error("Invalid token payload"));
    }

    next();
  } catch (error) {
    next(new Error("Invalid or expired socket token"));
  }
});

// Check whether a user belongs to a conversation.
const isConversationMember = async (userId, conversationId) => {
  const membership = await prisma.conversationMember.findUnique({
    where: {
      userId_conversationId: {
        userId,
        conversationId,
      },
    },
  });

  return Boolean(membership);
};

io.on("connection", (socket) => {
  const userId = socket.userId;

  console.log("User connected:", userId, socket.id);

  // Register online user.
  const userSockets = onlineUsers.get(userId) || new Set();

  const wasOffline = userSockets.size === 0;

  userSockets.add(socket.id);
  onlineUsers.set(userId, userSockets);

  // Send the initial online users list.
  socket.emit("online_users", Array.from(onlineUsers.keys()));

  // Notify other users when this user comes online.
  if (wasOffline) {
    socket.broadcast.emit("user_status", {
      userId,
      isOnline: true,
    });
  }

  // ------------------------------------------------
  // JOIN CONVERSATION
  // ------------------------------------------------

  socket.on("join_conversation", async (conversationId, callback) => {
    try {
      if (!conversationId) {
        return callback?.({
          error: "Conversation ID is required",
        });
      }

      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) {
        return callback?.({
          error: "You are not a member of this conversation",
        });
      }

      socket.join(conversationId);

      callback?.({
        success: true,
      });
    } catch (error) {
      console.error("Join conversation error:", error);

      callback?.({
        error: "Could not join conversation",
      });
    }
  });

  // ------------------------------------------------
  // TYPING INDICATORS
  // ------------------------------------------------

  socket.on("typing", async (conversationId) => {
    try {
      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) return;

      socket.to(conversationId).emit("user_typing", {
        conversationId,
        userId,
      });
    } catch (error) {
      console.error("Typing error:", error);
    }
  });

  socket.on("stop_typing", async (conversationId) => {
    try {
      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) return;

      socket.to(conversationId).emit("user_stop_typing", {
        conversationId,
        userId,
      });
    } catch (error) {
      console.error("Stop typing error:", error);
    }
  });

  // ------------------------------------------------
  // MESSAGE DELIVERY RECEIPT
  // ------------------------------------------------

  socket.on("message_delivered", async (messageId) => {
    try {
      const message = await prisma.message.findUnique({
        where: {
          id: messageId,
        },
        include: {
          conversation: {
            include: {
              members: true,
            },
          },
        },
      });

      if (!message || message.senderId === userId) return;

      const isMember = message.conversation.members.some(
        (member) => member.userId === userId,
      );

      if (!isMember) return;

      const now = new Date();

      await prisma.messageReceipt.upsert({
        where: {
          messageId_userId: {
            messageId,
            userId,
          },
        },
        create: {
          messageId,
          userId,
          deliveredAt: now,
        },
        update: {
          deliveredAt: now,
        },
      });

      const receipt = await prisma.messageReceipt.findUnique({
        where: {
          messageId_userId: {
            messageId,
            userId,
          },
        },
      });

      io.to(message.conversationId).emit("message_receipt_updated", {
        messageId,
        userId,
        status: "DELIVERED",
        deliveredAt: receipt.deliveredAt,
        readAt: receipt.readAt,
      });
    } catch (error) {
      console.error("Message delivery error:", error);
    }
  });

  // ------------------------------------------------
  // MESSAGE READ RECEIPT
  // ------------------------------------------------

  socket.on("mark_messages_read", async (conversationId) => {
    try {
      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) return;

      const incomingMessages = await prisma.message.findMany({
        where: {
          conversationId,
          senderId: {
            not: userId,
          },
        },
        select: {
          id: true,
        },
      });

      if (incomingMessages.length === 0) return;

      const messageIds = incomingMessages.map((message) => message.id);

      const now = new Date();

      // Create missing receipt records.
      await prisma.messageReceipt.createMany({
        data: messageIds.map((messageId) => ({
          messageId,
          userId,
          deliveredAt: now,
          readAt: now,
        })),
        skipDuplicates: true,
      });

      // Update existing unread receipts.
      await prisma.messageReceipt.updateMany({
        where: {
          messageId: {
            in: messageIds,
          },
          userId,
          readAt: null,
        },
        data: {
          deliveredAt: now,
          readAt: now,
        },
      });

      // Notify conversation members about updated receipts.
      const receipts = await prisma.messageReceipt.findMany({
        where: {
          messageId: {
            in: messageIds,
          },
          userId,
        },
      });

      receipts.forEach((receipt) => {
        io.to(conversationId).emit("message_receipt_updated", {
          messageId: receipt.messageId,
          userId: receipt.userId,
          status: "READ",
          deliveredAt: receipt.deliveredAt,
          readAt: receipt.readAt,
        });
      });
    } catch (error) {
      console.error("Mark messages read error:", error);
    }
  });

  // ------------------------------------------------
  // DISCONNECT
  // ------------------------------------------------

  socket.on("disconnect", () => {
    console.log("User disconnected:", userId, socket.id);

    const userSockets = onlineUsers.get(userId);

    if (userSockets) {
      userSockets.delete(socket.id);

      if (userSockets.size === 0) {
        onlineUsers.delete(userId);

        io.emit("user_status", {
          userId,
          isOnline: false,
        });
      }
    }
  });
});

// --------------------------------------------------
// SEARCH USERS
// --------------------------------------------------

app.get("/api/users/search", verifyToken, async (req, res) => {
  try {
    const search = req.query.search?.trim();

    if (!search) {
      return res.status(200).json({
        users: [],
      });
    }

    const users = await prisma.user.findMany({
      where: {
        id: {
          not: req.user.id,
        },
        OR: [
          {
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            email: {
              contains: search,
              mode: "insensitive",
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
      take: 20,
    });

    res.status(200).json({
      users,
    });
  } catch (error) {
    console.error("Search users error:", error);

    res.status(500).json({
      message: "Could not search users",
    });
  }
});

// --------------------------------------------------
// GET PREVIOUS CONVERSATIONS
// --------------------------------------------------

app.get("/api/conversations", verifyToken, async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        members: {
          some: {
            userId: req.user.id,
          },
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        messages: {
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    res.status(200).json({
      conversations,
    });
  } catch (error) {
    console.error("Get conversations error:", error);

    res.status(500).json({
      message: "Failed to fetch conversations",
    });
  }
});

// --------------------------------------------------
// CREATE OR OPEN ONE-TO-ONE CONVERSATION
// --------------------------------------------------

app.post("/api/conversations", verifyToken, async (req, res) => {
  try {
    const { receiverId } = req.body;
    const userId = req.user.id;

    if (!receiverId || receiverId === userId) {
      return res.status(400).json({
        message: "Valid receiver ID is required",
      });
    }

    const receiver = await prisma.user.findUnique({
      where: {
        id: receiverId,
      },
    });

    if (!receiver) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // Check whether a one-to-one conversation already exists.
    const existingConversation = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          {
            members: {
              some: {
                userId,
              },
            },
          },
          {
            members: {
              some: {
                userId: receiverId,
              },
            },
          },
        ],
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (existingConversation) {
      return res.status(200).json({
        conversation: existingConversation,
      });
    }

    const conversation = await prisma.conversation.create({
      data: {
        isGroup: false,
        members: {
          create: [
            {
              userId,
            },
            {
              userId: receiverId,
            },
          ],
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    res.status(201).json({
      conversation,
    });
  } catch (error) {
    console.error("Create conversation error:", error);

    res.status(500).json({
      message: "Could not create conversation",
    });
  }
});

// --------------------------------------------------
// CREATE GROUP CONVERSATION
// --------------------------------------------------

app.post("/api/conversations/group", verifyToken, async (req, res) => {
  try {
    const { title, memberIds } = req.body;
    const userId = req.user.id;

    if (!title?.trim()) {
      return res.status(400).json({
        message: "Group name is required",
      });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        message: "Select at least one group member",
      });
    }

    const uniqueMemberIds = [
      ...new Set(memberIds.filter((id) => id !== userId)),
    ];

    const users = await prisma.user.findMany({
      where: {
        id: {
          in: uniqueMemberIds,
        },
      },
      select: {
        id: true,
      },
    });

    if (users.length !== uniqueMemberIds.length) {
      return res.status(400).json({
        message: "One or more selected users do not exist",
      });
    }

    const conversation = await prisma.conversation.create({
      data: {
        title: title.trim(),
        isGroup: true,
        members: {
          create: [
            {
              userId,
              role: "ADMIN",
            },
            ...uniqueMemberIds.map((memberId) => ({
              userId: memberId,
              role: "MEMBER",
            })),
          ],
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    res.status(201).json({
      conversation,
    });
  } catch (error) {
    console.error("Create group error:", error);

    res.status(500).json({
      message: "Could not create group",
    });
  }
});

// --------------------------------------------------
// REMOVE GROUP MEMBER
// --------------------------------------------------

app.delete(
  "/api/conversations/:conversationId/members/:memberId",
  verifyToken,
  async (req, res) => {
    try {
      const { conversationId, memberId } = req.params;
      const userId = req.user.id;

      const adminMembership = await prisma.conversationMember.findUnique({
        where: {
          userId_conversationId: {
            userId,
            conversationId,
          },
        },
      });

      if (!adminMembership || adminMembership.role !== "ADMIN") {
        return res.status(403).json({
          message: "Only group admins can remove members",
        });
      }

      const conversation = await prisma.conversation.findUnique({
        where: {
          id: conversationId,
        },
      });

      if (!conversation || !conversation.isGroup) {
        return res.status(404).json({
          message: "Group conversation not found",
        });
      }

      if (memberId === userId) {
        return res.status(400).json({
          message: "You cannot remove yourself from the group",
        });
      }

      const membership = await prisma.conversationMember.findUnique({
        where: {
          userId_conversationId: {
            userId: memberId,
            conversationId,
          },
        },
      });

      if (!membership) {
        return res.status(404).json({
          message: "Group member not found",
        });
      }

      if (membership.role === "ADMIN") {
        return res.status(403).json({
          message: "An admin cannot be removed",
        });
      }

      await prisma.conversationMember.delete({
        where: {
          userId_conversationId: {
            userId: memberId,
            conversationId,
          },
        },
      });

      // Remove the deleted user's sockets from this group room.
      const removedUserSockets = onlineUsers.get(memberId);

      if (removedUserSockets) {
        removedUserSockets.forEach((socketId) => {
          const memberSocket = io.sockets.sockets.get(socketId);

          memberSocket?.leave(conversationId);
          memberSocket?.emit("removed_from_group", {
            conversationId,
            message: "You have been removed from this group",
          });
        });
      }

      // Inform the remaining group members.
      io.to(conversationId).emit("group_member_removed", {
        conversationId,
        memberId,
      });

      res.status(200).json({
        message: "Group member removed successfully",
      });
    } catch (error) {
      console.error("Remove group member error:", error);

      res.status(500).json({
        message: "Could not remove group member",
      });
    }
  },
);

// --------------------------------------------------
// GET MESSAGE HISTORY
// --------------------------------------------------

app.get("/api/messages/:conversationId", verifyToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const isMember = await isConversationMember(userId, conversationId);

    if (!isMember) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        receipts: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    res.status(200).json({
      messages,
    });
  } catch (error) {
    console.error("Get messages error:", error);

    res.status(500).json({
      message: "Could not fetch messages",
    });
  }
});

// --------------------------------------------------
// SAVE MESSAGE AND BROADCAST
// --------------------------------------------------

app.post("/api/messages", verifyToken, async (req, res) => {
  try {
    const { conversationId, content } = req.body;
    const senderId = req.user.id;

    if (!conversationId || !content?.trim()) {
      return res.status(400).json({
        message: "Conversation ID and message content are required",
      });
    }

    if (content.trim().length > 5000) {
      return res.status(400).json({
        message: "Message cannot exceed 5000 characters",
      });
    }

    const conversation = await prisma.conversation.findUnique({
      where: {
        id: conversationId,
      },
      include: {
        members: true,
      },
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const isMember = conversation.members.some(
      (member) => member.userId === senderId,
    );

    if (!isMember) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    // Save the message first.
    const message = await prisma.message.create({
      data: {
        content: content.trim(),
        senderId,
        conversationId,
      },
    });

    // Create pending delivery receipts for other members.
    const otherMembers = conversation.members.filter(
      (member) => member.userId !== senderId,
    );

    if (otherMembers.length > 0) {
      await prisma.messageReceipt.createMany({
        data: otherMembers.map((member) => ({
          messageId: message.id,
          userId: member.userId,
        })),
        skipDuplicates: true,
      });
    }

    // Update conversation's latest activity.
    await prisma.conversation.update({
      where: {
        id: conversationId,
      },
      data: {
        updatedAt: new Date(),
      },
    });

    // Return message with sender and receipt information.
    const savedMessage = await prisma.message.findUnique({
      where: {
        id: message.id,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        receipts: true,
      },
    });

    // Broadcast only after successful database save.
    io.to(conversationId).emit("new_message", savedMessage);

    res.status(201).json({
      message: savedMessage,
    });
  } catch (error) {
    console.error("Send message error:", error);

    res.status(500).json({
      message: "Could not send message",
    });
  }
});

// --------------------------------------------------
// TEST API
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "Realtime Chat Backend is running!",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  server.close(() => {
    process.exit(0);
  });
});
