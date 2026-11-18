import { Button } from "@/components/ui/button";

/** "Open Container" action shared by the container-linked daybook entry views. */
export function OpenContainerButton({
  containerId,
  onClose,
  onNavigate,
}: {
  containerId: number | null | undefined;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  return (
    <Button
      size="sm"
      variant="default"
      onClick={() => {
        onClose();
        onNavigate(`/factory/containers?edit=${containerId}`);
      }}
      data-testid="button-open-container"
    >
      Open Container
    </Button>
  );
}
