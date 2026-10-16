package name.abuchen.portfolio.model;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.channels.FileChannel;
import java.util.Set;

/**
 * Provides save functionality without requiring the Eclipse OSGi runtime.
 * Uses ClientFactory's internal ClientPersister pipeline via reflection.
 */
public class HeadlessSave {

    public static void save(Client client, File file, char[] password) throws IOException {
        // Use getSaveFlags to check if encrypted (don't reference SaveFlag enum directly)
        var flags = client.getSaveFlags();
        boolean isEncrypted = flags.stream().anyMatch(f -> f.name().equals("ENCRYPTED"));
        if (flags.isEmpty())
            flags.stream().findFirst().ifPresent(f -> {}); // no-op

        if (isEncrypted && password == null && client.getSecret() == null)
            throw new IOException("Password is missing");

        byte[] originalBackup = null;
        if (file.exists()) {
            try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                originalBackup = fis.readAllBytes();
            } catch (IOException e) {
                originalBackup = null;
            }
        }

        try (FileOutputStream fos = new FileOutputStream(file);
             BufferedOutputStream bos = new BufferedOutputStream(fos, 65536)) {

            FileChannel channel = fos.getChannel();
            try {
                channel.tryLock();
            } catch (IOException ignored) {
            }

            java.lang.reflect.Method buildPersister = ClientFactory.class.getDeclaredMethod(
                "buildPersister", java.util.Set.class, char[].class);
            buildPersister.setAccessible(true);
            Object persister = buildPersister.invoke(null, flags, password);

            java.lang.reflect.Method saveMethod = persister.getClass().getMethod("save", Client.class, java.io.OutputStream.class);
            saveMethod.invoke(persister, client, bos);
            bos.flush();

            client.getSaveFlags().clear();
            client.getSaveFlags().addAll(flags);
        } catch (IOException e) {
            // Restore backup on failure
            if (originalBackup != null) {
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(originalBackup);
                } catch (IOException ignored) {}
            }
            throw e;
        } catch (Exception e) {
            if (originalBackup != null) {
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(originalBackup);
                } catch (IOException ignored) {}
            }
            throw new IOException("Save failed: " + e.getMessage(), e);
        }

        // Validate: try to reload
        try {
            ClientFactory.load(file, password != null ? password : new char[0], new org.eclipse.core.runtime.NullProgressMonitor());
        } catch (Exception e) {
            // Restore backup if validation fails
            if (originalBackup != null) {
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(originalBackup);
                } catch (IOException ignored) {}
            }
            throw new IOException("Save validation failed (file may be corrupted): " + e.getMessage(), e);
        }
    }
}
