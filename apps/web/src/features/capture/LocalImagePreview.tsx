import { useEffect, useState } from "react";

export interface LocalImagePreviewProps {
  readonly blob: Blob;
  readonly alt: string;
  readonly className?: string;
}

export function LocalImagePreview({
  blob,
  alt,
  className,
}: LocalImagePreviewProps) {
  const [source, setSource] = useState<string | undefined>();
  const [failedSource, setFailedSource] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    let nextSource: string;
    try {
      nextSource = URL.createObjectURL(blob);
    } catch {
      queueMicrotask(() => {
        if (active) {
          setSource(undefined);
        }
      });
      return () => {
        active = false;
      };
    }

    queueMicrotask(() => {
      if (active) {
        setFailedSource(undefined);
        setSource(nextSource);
      }
    });

    return () => {
      active = false;
      URL.revokeObjectURL(nextSource);
    };
  }, [blob]);

  return (
    <span className={className} role="img" aria-label={alt}>
      {source === undefined || failedSource === source ? (
        "图片预览不可用"
      ) : (
        <img
          src={source}
          alt=""
          onError={() => {
            setFailedSource(source);
          }}
        />
      )}
    </span>
  );
}
