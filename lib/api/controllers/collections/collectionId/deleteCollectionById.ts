import { prisma } from "@/lib/api/db";
import getPermission from "@/lib/api/getPermission";
import { Link, UsersAndCollections } from "@prisma/client";
import removeFolder from "@/lib/api/storage/removeFolder";
import { meiliClient } from "@/lib/api/meilisearchClient";

export default async function deleteCollection(
  userId: number,
  collectionId: number
) {
  if (!collectionId)
    return { response: "Please choose a valid collection.", status: 401 };

  const collectionIsAccessible = await getPermission({
    userId,
    collectionId,
  });

  const memberHasAccess = collectionIsAccessible?.members.some(
    (e: UsersAndCollections) => e.userId === userId
  );

  if (collectionIsAccessible?.ownerId !== userId && memberHasAccess) {
    // Remove relation/Leave collection
    const deletedUsersAndCollectionsRelation =
      await prisma.usersAndCollections.delete({
        where: {
          userId_collectionId: {
            userId: userId,
            collectionId: collectionId,
          },
        },
      });

    await removeFromOrders(userId, collectionId);

    await prisma.link.updateMany({
      where: {
        collectionId,
      },
      data: {
        indexVersion: null,
      },
    });

    return { response: deletedUsersAndCollectionsRelation, status: 200 };
  } else if (collectionIsAccessible?.ownerId !== userId) {
    return { response: "Collection is not accessible.", status: 401 };
  }

  const deletedCollection = await prisma.$transaction(async () => {
    await deleteSubCollections(collectionId);

    await prisma.usersAndCollections.deleteMany({
      where: {
        collection: {
          id: collectionId,
        },
      },
    });

    removeFolder({ filePath: `archives/${collectionId}` });
    removeFolder({ filePath: `archives/preview/${collectionId}` });

    await removeFromOrders(userId, collectionId);

    return await prisma.collection.delete({
      where: {
        id: collectionId,
      },
      include: {
        links: true,
      },
    });
  });

  const { links, ...data } = deletedCollection;

  const linkIds = links.map((link) => link.id);

  meiliClient?.index("links").deleteDocuments(linkIds);

  return { response: data, status: 200 };
}

async function deleteSubCollections(collectionId: number) {
  const subCollections = await prisma.collection.findMany({
    where: { parentId: collectionId },
  });

  for (const subCollection of subCollections) {
    await deleteSubCollections(subCollection.id);

    await prisma.usersAndCollections.deleteMany({
      where: {
        collection: {
          id: subCollection.id,
        },
      },
    });

    const links = await prisma.link.findMany({
      where: {
        collectionId: subCollection.id,
      },
      select: {
        id: true,
      },
    });

    const linkIds = links.map((link) => link.id);

    meiliClient?.index("links").deleteDocuments(linkIds);

    await prisma.link.deleteMany({
      where: {
        collection: {
          id: subCollection.id,
        },
      },
    });

    await prisma.collection.delete({
      where: { id: subCollection.id },
    });

    removeFolder({ filePath: `archives/${subCollection.id}` });
    removeFolder({ filePath: `archives/preview/${subCollection.id}` });
  }
}

async function removeFromOrders(userId: number, collectionId: number) {
  const userCollectionOrder = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      collectionOrder: true,
    },
  });

  if (userCollectionOrder)
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        collectionOrder: {
          set: userCollectionOrder.collectionOrder.filter(
            (e: number) => e !== collectionId
          ),
        },
      },
    });
}
